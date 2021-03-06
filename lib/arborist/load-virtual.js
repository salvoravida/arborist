// mixin providing the loadVirtual method

const {dirname, resolve} = require('path')
const walkUp = require('walk-up-path')

const nameFromFolder = require('@npmcli/name-from-folder')
const consistentResolve = require('../consistent-resolve.js')
const Shrinkwrap = require('../shrinkwrap.js')
const Node = require('../node.js')
const Link = require('../link.js')
const relpath = require('../relpath.js')
const calcDepFlags = require('../calc-dep-flags.js')
const rpj = require('read-package-json-fast')

const loadFromShrinkwrap = Symbol('loadFromShrinkwrap')
const resolveNodes = Symbol('resolveNodes')
const resolveLinks = Symbol('resolveLinks')
const assignParentage = Symbol('assignParentage')
const loadRoot = Symbol('loadRoot')
const loadNode = Symbol('loadVirtualNode')
const loadLink = Symbol('loadVirtualLink')
const loadWorkspaces = Symbol.for('loadWorkspaces')
const loadWorkspacesVirtual = Symbol.for('loadWorkspacesVirtual')
const flagsSuspect = Symbol.for('flagsSuspect')
const reCalcDepFlags = Symbol('reCalcDepFlags')
const checkRootEdges = Symbol('checkRootEdges')

const depsToEdges = (type, deps) =>
  Object.entries(deps).map(d => [type, ...d])

module.exports = cls => class VirtualLoader extends cls {
  constructor (options) {
    super(options)

    // the virtual tree we load from a shrinkwrap
    this.virtualTree = options.virtualTree
    this[flagsSuspect] = false
  }

  // public method
  async loadVirtual (options = {}) {
    if (this.virtualTree)
      return Promise.resolve(this.virtualTree)

    // allow the user to set reify options on the ctor as well.
    // XXX: deprecate separate reify() options object.
    options = { ...this.options, ...options }

    if (options.root && options.root.meta)
      return this[loadFromShrinkwrap](options.root.meta, options.root)

    const s = await Shrinkwrap.load({ path: this.path })
    if (!s.loadedFromDisk && !options.root) {
      const er = new Error('loadVirtual requires existing shrinkwrap file')
      throw Object.assign(er, { code: 'ENOLOCK' })
    }

    // when building the ideal tree, we pass in a root node to this function
    // otherwise, load it from the root package json or the lockfile
    const {
      root = await this[loadRoot](s),
    } = options

    return this[loadFromShrinkwrap](s, root)
  }

  async [loadRoot] (s) {
    const pj = this.path + '/package.json'
    const pkg = await rpj(pj).catch(() => s.data.packages['']) || {}
    return this[loadWorkspaces](this[loadNode]('', pkg))
  }

  async [loadFromShrinkwrap] (s, root) {
    // root is never any of these things, but might be a brand new
    // baby Node object that never had its dep flags calculated.
    root.extraneous = false
    root.dev = false
    root.optional = false
    root.devOptional = false
    root.peer = false
    this[checkRootEdges](s, root)
    root.meta = s
    this.virtualTree = root
    const {links, nodes} = this[resolveNodes](s, root)
    await this[resolveLinks](links, nodes)
    this[assignParentage](nodes)
    if (this[flagsSuspect])
      this[reCalcDepFlags]()
    return root
  }

  [reCalcDepFlags] () {
    // reset all dep flags
    for (const node of this.virtualTree.inventory.values()) {
      node.extraneous = true
      node.dev = true
      node.optional = true
      node.devOptional = true
      node.peer = true
    }
    calcDepFlags(this.virtualTree, true)
  }

  // check the lockfile deps, and see if they match.  if they do not
  // then we have to reset dep flags at the end.  for example, if the
  // user manually edits their package.json file, then we need to know
  // that the idealTree is no longer entirely trustworthy.
  [checkRootEdges] (s, root) {
    // loaded virtually from tree, no chance of being out of sync
    // ancient lockfiles are critically damaged by this process,
    // so we need to just hope for the best in those cases.
    if (!s.loadedFromDisk || s.ancientLockfile)
      return

    const lock = s.get('')
    const prod = lock.dependencies || {}
    const dev = lock.devDependencies || {}
    const optional = lock.optionalDependencies || {}
    const peer = lock.peerDependencies || {}
    const peerOptional = {}
    if (lock.peerDependenciesMeta) {
      for (const [name, meta] of Object.entries(lock.peerDependenciesMeta)) {
        if (meta.optional && peer[name] !== undefined) {
          peerOptional[name] = peer[name]
          delete peer[name]
        }
      }
    }
    for (const name of Object.keys(optional))
      delete prod[name]

    const lockWS = []
    const workspaces = this[loadWorkspacesVirtual]({
      cwd: this.path,
      lockfile: s.data,
    })
    for (const [name, path] of workspaces.entries())
      lockWS.push(['workspace', name, `file:${path}`])

    const lockEdges = [
      ...depsToEdges('prod', prod),
      ...depsToEdges('dev', dev),
      ...depsToEdges('optional', optional),
      ...depsToEdges('peer', peer),
      ...depsToEdges('peerOptional', peerOptional),
      ...lockWS,
    ].sort(([atype, aname], [btype, bname]) =>
      atype.localeCompare(btype) || aname.localeCompare(bname))

    const rootEdges = [...root.edgesOut.values()]
      .map(e => [e.type, e.name, e.spec])
      .sort(([atype, aname], [btype, bname]) =>
        atype.localeCompare(btype) || aname.localeCompare(bname))

    if (rootEdges.length !== lockEdges.length) {
      // something added or removed
      return this[flagsSuspect] = true
    }

    for (let i = 0; i < lockEdges.length; i++) {
      if (rootEdges[i][0] !== lockEdges[i][0] ||
          rootEdges[i][1] !== lockEdges[i][1] ||
          rootEdges[i][2] !== lockEdges[i][2])
        return this[flagsSuspect] = true
    }
  }

  // separate out link metadatas, and create Node objects for nodes
  [resolveNodes] (s, root) {
    const links = new Map()
    const nodes = new Map([['', root]])
    for (const [location, meta] of Object.entries(s.data.packages)) {
      // skip the root because we already got it
      if (!location)
        continue

      if (meta.link)
        links.set(location, meta)
      else
        nodes.set(location, this[loadNode](location, meta))
    }
    return {links, nodes}
  }

  // links is the set of metadata, and nodes is the map of non-Link nodes
  // Set the targets to nodes in the set, if we have them (we might not)
  async [resolveLinks] (links, nodes) {
    // now we've loaded the root, and all real nodes
    // link up the links
    const {meta} = this.virtualTree
    const {loadedFromDisk, originalLockfileVersion} = meta
    const oldLockfile = loadedFromDisk && !(originalLockfileVersion >= 2)

    for (const [location, meta] of links.entries()) {
      const targetPath = resolve(this.path, meta.resolved)
      const targetLoc = relpath(this.path, targetPath)
      const target = nodes.get(targetLoc)
      const link = this[loadLink](location, targetLoc, target, meta)
      nodes.set(location, link)
      nodes.set(targetLoc, link.target)
      // legacy shrinkwraps do not store all the info we need for the target.
      // if we're loading from disk, and have a link in place, we need to
      // look in that actual folder (or at least try to) in order to get
      // the dependencies of the link target and load it properly.
      if (oldLockfile) {
        const pj = link.realpath + '/package.json'
        const pkg = await rpj(pj).catch(() => null)
        if (pkg)
          link.target.package = pkg
      }
    }
  }

  [assignParentage] (nodes) {
    for (const [location, node] of nodes) {
      const { path, name } = node
      for (const p of walkUp(dirname(path))) {
        const ploc = relpath(this.path, p)
        const parent = nodes.get(ploc)
        if (!parent)
          continue

        const locTest = `${ploc}/node_modules/${name}`.replace(/^\//, '')
        const ptype = location === locTest
          ? 'parent'
          : 'fsParent'
        node[ptype] = parent
        // read inBundle from package because 'package' here is
        // actually a v2 lockfile metadata entry.
        // If the *parent* is also bundled, though, then we assume
        // that it's being pulled in just by virtue of that.
        const {inBundle} = node.package
        const ppkg = parent.package
        const {inBundle: parentBundled} = ppkg
        const hasEdge = parent.edgesOut.has(name)
        if (ptype === 'parent' && inBundle && hasEdge && !parentBundled) {
          if (!ppkg.bundleDependencies)
            ppkg.bundleDependencies = [name]
          else if (!ppkg.bundleDependencies.includes(name))
            ppkg.bundleDependencies.push(name)
        }

        break
      }
    }
  }

  [loadNode] (location, sw) {
    const path = resolve(this.path, location)
    // shrinkwrap doesn't include package name unless necessary
    if (!sw.name)
      sw.name = nameFromFolder(path)
    const node = new Node({
      legacyPeerDeps: this.legacyPeerDeps,
      root: this.virtualTree,
      path,
      realpath: path,
      integrity: sw.integrity,
      resolved: consistentResolve(sw.resolved, this.path, path),
      pkg: sw,
      hasShrinkwrap: sw.hasShrinkwrap,
    })
    // cast to boolean because they're undefined in the lock file when false
    node.extraneous = !!sw.extraneous
    node.devOptional = !!(sw.devOptional || sw.dev || sw.optional)
    node.peer = !!sw.peer
    node.optional = !!sw.optional
    node.dev = !!sw.dev
    return node
  }

  [loadLink] (location, targetLoc, target, meta) {
    const path = resolve(this.path, location)
    const link = new Link({
      legacyPeerDeps: this.legacyPeerDeps,
      path,
      realpath: resolve(this.path, targetLoc),
      target,
      pkg: target && target.package,
    })
    link.extraneous = target.extraneous
    link.devOptional = target.devOptional
    link.peer = target.peer
    link.optional = target.optional
    link.dev = target.dev
    return link
  }
}
