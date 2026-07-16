#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createCandidateDescriptor,
  verifyCandidateDescriptor,
} from '../lib/candidate-descriptor.mjs'
import {
  cloneDependencySnapshot,
  loadDependencyContract,
  verifyDependencySnapshot,
} from '../lib/dependencies.mjs'
import { loadAndVerifyManifest } from '../lib/manifest.mjs'
import { verifyPackagedApp } from '../lib/package-verifier.mjs'
import { assertEqual, treeInventory } from '../lib/data-rehearsal.mjs'
import {
  acquireLock,
  assertSha,
  atomicPointSymlink,
  atomicWriteJson,
  fail,
  git,
  gitText,
  parseSyncArguments,
  promoteRefs,
  releaseLock,
  run,
  safeEnvironment,
  sha256File,
  writeNewFile,
  writeNewJson,
} from '../lib/sync-controller.mjs'

const workflowRoot = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'))
const workspaceRoot = fs.realpathSync(path.resolve(workflowRoot, '..'))
const paths = {
  workflow: workflowRoot,
  upstream: path.join(workspaceRoot, 'GatherOS-Upstream'),
  acceptedLink: path.join(workspaceRoot, 'GatherLocal-Next'),
  acceptedStore: path.join(workspaceRoot, 'GatherLocal-Accepted.git'),
  reconstructions: path.join(workspaceRoot, 'GatherLocal-Reconstructions'),
  preservation: path.join(workspaceRoot, 'Preservation'),
  controllerRuns: path.join(workspaceRoot, '.gatherlocal-sync-runs'),
  lock: path.join(workspaceRoot, '.gatherlocal-sync-runs', 'LOCK'),
  state: path.join(workflowRoot, 'runs', 'accepted-state.json'),
}
const UPSTREAM_URL = 'https://github.com/BrettfromDJ/GatherOS.git'
const dependencyContractPath = path.join(workflowRoot, 'manifests/dependencies.v1.json')
const preservationSnapshot = path.join(paths.preservation, 'GatherLocal-20260714T062004Z')

function runId() {
  return `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-${crypto.randomBytes(4).toString('hex')}`
}

function scrubProcessEnvironment(environment) {
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, environment)
}

function physicalDirectory(directory, label) {
  const stat = fs.lstatSync(directory)
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`${label} must be a physical directory`)
  return fs.realpathSync(directory)
}

function assertNotRunning(directory, env, logFile) {
  const result = run('/bin/ps', ['-axo', 'command='], { env, logFile })
  const physical = fs.realpathSync(directory)
  if (result.stdout.split('\n').some(line => line.includes(physical))) {
    fail('accepted reconstruction appears to be running; close its dev/app processes before init')
  }
}

function assertClean(repository, label, env, logFile) {
  if (gitText(['status', '--porcelain'], repository, { env, logFile }) !== '') {
    fail(`${label} must be clean`)
  }
  for (const marker of ['rebase-apply', 'rebase-merge', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'BISECT_LOG']) {
    const gitPath = gitText(['rev-parse', '--git-path', marker], repository, { env, logFile })
    if (fs.existsSync(path.resolve(repository, gitPath))) fail(`${label} has interrupted Git state: ${marker}`)
  }
}

function ensureWorkflowBoundary(env, logFile) {
  run(path.join(workflowRoot, 'scripts/check-boundary.sh'), [], {
    cwd: workflowRoot,
    env,
    logFile,
  })
  assertClean(workflowRoot, 'workflow repository', env, logFile)
}

function stablePatchId(commit, repository, env, logFile) {
  const diff = git(['show', '--format=', '--full-index', '--binary', commit], repository, { env, logFile }).stdout
  const result = git(['patch-id', '--stable'], repository, { env, input: Buffer.from(diff), logFile }).stdout.trim()
  const id = result.split(/\s+/)[0]
  assertSha(id, 'stable patch ID')
  return id
}

function ancestry(repository, ancestor, descendant, env, label, logFile) {
  const result = git(['merge-base', '--is-ancestor', ancestor, descendant], repository, {
    env,
    allowFailure: true,
    logFile,
  })
  if (result.status !== 0) fail(`${label} ancestry check failed`)
}

function verifyBundle(bundle, repository, env, logFile) {
  git(['bundle', 'verify', bundle], repository, { env, logFile })
}

function restoreBundle(bundle, destination, env, logFile) {
  git(['init', '--bare', destination], path.dirname(destination), { env, logFile })
  git(['fetch', '--no-tags', '--no-write-fetch-head', bundle, 'refs/*:refs/*'], destination, { env, logFile })
  git(['fsck', '--full'], destination, { env, logFile })
}

function checksumManifest(directory, files) {
  return files.map(file => `${sha256File(path.join(directory, file))}  ${file}`).join('\n') + '\n'
}

function createInitEvidence({ id, accepted, tip, tree, manifest, dependencyReceipt, bundle, env, logFile }) {
  const directory = path.join(paths.preservation, `GatherLocal-Acceptance-Init-${id}`)
  fs.mkdirSync(directory)
  const physicalCopy = path.join(directory, 'GatherLocal-Next-physical')
  run('/bin/cp', ['-cR', accepted, physicalCopy], { cwd: directory, env, logFile, timeout: 10 * 60_000 })
  const physicalInventory = treeInventory(physicalCopy, { includeContent: true })
  const bundlePath = path.join(directory, 'GatherLocal-Next.bundle')
  fs.renameSync(bundle, bundlePath)
  verifyBundle(bundlePath, accepted, env, logFile)
  const receipt = {
    schema_version: 1,
    receipt_id: 'gatherlocal-acceptance-init',
    run_id: id,
    accepted_tip: tip,
    accepted_tree: tree,
    upstream_target: manifest.upstream.tested_base,
    canonical_evidence_ref: manifest.source.canonical_evidence_ref,
    dependency_snapshot: dependencyReceipt,
    physical_copy_inventory: physicalInventory,
    created_at: new Date().toISOString(),
  }
  writeNewJson(path.join(directory, 'receipt.json'), receipt)
  writeNewFile(path.join(directory, 'README.md'), [
    '# GatherLocal acceptance topology initialization',
    '',
    `Accepted tip: \`${tip}\``,
    `Accepted tree: \`${tree}\``,
    `Upstream target: \`${manifest.upstream.tested_base}\``,
    '',
    'Physical APFS copy preserves complete pre-topology checkout, including ignored dependencies and build output.',
    'Git bundle independently preserves all Git refs and objects.',
    'Bare acceptance store refs are authoritative; GatherLocal-Next becomes an atomic convenience symlink.',
    '',
  ].join('\n'))
  writeNewFile(path.join(directory, 'SHA256SUMS'), checksumManifest(directory, [
    'GatherLocal-Next.bundle', 'receipt.json', 'README.md',
  ]))
  run('/usr/bin/shasum', ['-a', '256', '-c', 'SHA256SUMS'], { cwd: directory, env, logFile })
  return directory
}

function initializeTopology(id, runRoot, env, logFile) {
  ensureWorkflowBoundary(env, logFile)
  if (fs.existsSync(paths.acceptedStore) || fs.existsSync(paths.reconstructions)) {
    fail('acceptance topology already exists')
  }
  const accepted = physicalDirectory(paths.acceptedLink, 'current accepted reconstruction')
  assertNotRunning(accepted, env, logFile)
  assertClean(accepted, 'current accepted reconstruction', env, logFile)
  const manifest = loadAndVerifyManifest({ root: workflowRoot, source: accepted })
  const tip = gitText(['rev-parse', 'HEAD'], accepted, { env, logFile })
  const tree = gitText(['rev-parse', 'HEAD^{tree}'], accepted, { env, logFile })
  if (tip !== manifest.source.tip || tree !== manifest.source.resulting_tree) {
    fail('current accepted reconstruction does not match canonical first-rehearsal state')
  }
  if (gitText(['symbolic-ref', '--short', 'HEAD'], accepted, { env, logFile }) !== manifest.source.branch) {
    fail('current accepted branch does not match manifest')
  }
  const dependencyContract = loadDependencyContract(dependencyContractPath)
  const dependencyReceipt = verifyDependencySnapshot(accepted, dependencyContract, { env })
  if (gitText(['rev-parse', 'refs/heads/main^{commit}'], accepted, { env, logFile }) !== manifest.upstream.tested_base) {
    fail('current accepted main does not equal manifest tested base')
  }

  const bundle = path.join(runRoot, 'GatherLocal-Next.bundle')
  git(['bundle', 'create', bundle, '--all'], accepted, { env, logFile })
  verifyBundle(bundle, accepted, env, logFile)
  restoreBundle(bundle, path.join(runRoot, 'bundle-restore.git'), env, logFile)
  const evidenceDirectory = createInitEvidence({
    id, accepted, tip, tree, manifest, dependencyReceipt, bundle, env, logFile,
  })

  const stagedStore = path.join(runRoot, 'accepted-store.git')
  git(['init', '--bare', stagedStore], runRoot, { env, logFile })
  git(['config', 'push.default', 'nothing'], stagedStore, { env, logFile })
  git(['config', 'core.hooksPath', path.join(workflowRoot, '.githooks')], stagedStore, { env, logFile })
  git([
    'fetch', '--no-tags', '--no-write-fetch-head', accepted,
    `refs/heads/${manifest.source.branch}:refs/gatherlocal/accepted`,
    `${manifest.source.canonical_evidence_ref}:${manifest.source.canonical_evidence_ref}`,
  ], stagedStore, { env, logFile })
  git(['update-ref', 'refs/gatherlocal/upstream/accepted', manifest.upstream.tested_base], stagedStore, { env, logFile })
  git(['fsck', '--full'], stagedStore, { env, logFile })
  if (gitText(['remote'], stagedStore, { env, logFile }) !== '') fail('acceptance store gained a remote')

  fs.mkdirSync(paths.reconstructions)
  fs.renameSync(stagedStore, paths.acceptedStore)
  const immutablePath = path.join(paths.reconstructions, tip)
  fs.renameSync(paths.acceptedLink, immutablePath)
  const temporaryLink = path.join(workspaceRoot, `.GatherLocal-Next.${id}.tmp`)
  try {
    fs.symlinkSync(path.relative(workspaceRoot, immutablePath), temporaryLink, 'dir')
    fs.renameSync(temporaryLink, paths.acceptedLink)
  } catch (error) {
    try { fs.rmSync(temporaryLink, { force: true }) } catch {}
    if (!fs.existsSync(paths.acceptedLink) && fs.existsSync(immutablePath)) {
      fs.renameSync(immutablePath, paths.acceptedLink)
    }
    if (fs.existsSync(paths.acceptedStore)) fs.renameSync(paths.acceptedStore, stagedStore)
    try { fs.rmdirSync(paths.reconstructions) } catch {}
    throw error
  }
  if (fs.realpathSync(paths.acceptedLink) !== fs.realpathSync(immutablePath)) {
    fail('initial accepted pointer verification failed')
  }
  atomicWriteJson(paths.state, {
    schema_version: 1,
    accepted_tip: tip,
    accepted_tree: tree,
    upstream_target: manifest.upstream.tested_base,
    reconstruction: path.relative(workspaceRoot, immutablePath),
    evidence: path.relative(workspaceRoot, evidenceDirectory),
    updated_at: new Date().toISOString(),
  })
  return { accepted_tip: tip, accepted_tree: tree, evidence: evidenceDirectory }
}

function validateTopology(manifest, dependencyContract, env, logFile) {
  const store = physicalDirectory(paths.acceptedStore, 'acceptance store')
  if (gitText(['rev-parse', '--is-bare-repository'], store, { env, logFile }) !== 'true') {
    fail('acceptance store must be bare')
  }
  if (gitText(['remote'], store, { env, logFile }) !== '') fail('acceptance store must have no remotes')
  if (gitText(['config', '--local', '--get', 'push.default'], store, { env, logFile }) !== 'nothing') {
    fail('acceptance store push.default must be nothing')
  }
  const oldTip = gitText(['rev-parse', 'refs/gatherlocal/accepted'], store, { env, logFile })
  const previousTarget = gitText(['rev-parse', 'refs/gatherlocal/upstream/accepted'], store, { env, logFile })
  assertSha(oldTip, 'accepted tip')
  assertSha(previousTarget, 'accepted upstream target')

  const expectedAccepted = fs.realpathSync(path.join(paths.reconstructions, oldTip))
  const linkStat = fs.lstatSync(paths.acceptedLink)
  if (!linkStat.isSymbolicLink()) fail('GatherLocal-Next must be an accepted convenience symlink')
  let pointerRepaired = false
  let linkedAccepted = null
  try { linkedAccepted = fs.realpathSync(paths.acceptedLink) } catch {}
  if (linkedAccepted !== expectedAccepted) {
    assertClean(expectedAccepted, 'authoritative reconstruction before pointer repair', env, logFile)
    if (gitText(['rev-parse', 'HEAD'], expectedAccepted, { env, logFile }) !== oldTip) {
      fail('authoritative reconstruction cannot repair accepted pointer')
    }
    atomicPointSymlink(paths.acceptedLink, expectedAccepted)
    pointerRepaired = true
  }
  const accepted = fs.realpathSync(paths.acceptedLink)
  assertClean(accepted, 'accepted reconstruction', env, logFile)
  if (gitText(['rev-parse', 'HEAD'], accepted, { env, logFile }) !== oldTip) {
    fail('accepted reconstruction HEAD does not match accepted ref')
  }
  if (gitText(['symbolic-ref', '--short', 'HEAD'], accepted, { env, logFile }) !== manifest.source.branch) {
    fail('accepted reconstruction branch mismatch')
  }
  loadAndVerifyManifest({ root: workflowRoot, source: store })
  const dependencyReceipt = verifyDependencySnapshot(accepted, dependencyContract, { env })
  if (pointerRepaired) {
    atomicWriteJson(paths.state, {
      schema_version: 1,
      status: 'reconciled-from-authoritative-ref',
      accepted_tip: oldTip,
      upstream_target: previousTarget,
      reconstruction: path.relative(workspaceRoot, accepted),
      updated_at: new Date().toISOString(),
    })
  }
  return { store, accepted, oldTip, previousTarget, dependencyReceipt, pointerRepaired }
}

function verifyUpstream(env, logFile) {
  const upstream = physicalDirectory(paths.upstream, 'upstream checkout')
  assertClean(upstream, 'upstream checkout', env, logFile)
  if (gitText(['symbolic-ref', '--short', 'HEAD'], upstream, { env, logFile }) !== 'main') {
    fail('upstream checkout must use main')
  }
  if (gitText(['remote', 'get-url', 'upstream'], upstream, { env, logFile }) !== UPSTREAM_URL) {
    fail('upstream fetch URL mismatch')
  }
  if (gitText(['remote', 'get-url', '--push', 'upstream'], upstream, { env, logFile }) !== 'DISABLED') {
    fail('upstream push URL must stay disabled')
  }
  return upstream
}

function fetchTarget({ upstream, id, expected, previousTarget, manifest, env, logFile }) {
  const incoming = `refs/gatherlocal/incoming-upstream/${id}`
  if (git(['show-ref', '--verify', '--quiet', incoming], upstream, { env, allowFailure: true, logFile }).status === 0) {
    fail('incoming upstream ref already exists')
  }
  git([
    'fetch', '--atomic', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head',
    UPSTREAM_URL,
    `refs/heads/main:${incoming}`,
  ], upstream, { env, logFile, timeout: 5 * 60_000 })
  const target = gitText(['rev-parse', `${incoming}^{commit}`], upstream, { env, logFile })
  assertSha(target, 'fetched upstream target')
  if (expected && expected !== target) fail(`fetched upstream target ${target} does not match --target-sha ${expected}`)
  ancestry(upstream, manifest.upstream.release_floor, target, env, 'release floor', logFile)
  ancestry(upstream, manifest.upstream.tested_base, target, env, 'canonical tested base', logFile)
  ancestry(upstream, previousTarget, target, env, 'previous accepted target', logFile)

  const remoteRef = 'refs/remotes/upstream/main'
  const previousRemote = gitText(['rev-parse', remoteRef], upstream, { env, logFile })
  ancestry(upstream, previousRemote, target, env, 'current upstream remote ref', logFile)
  if (previousRemote !== target) git(['update-ref', remoteRef, target, previousRemote], upstream, { env, logFile })
  const localMain = gitText(['rev-parse', 'refs/heads/main'], upstream, { env, logFile })
  ancestry(upstream, localMain, target, env, 'upstream local main', logFile)
  if (localMain !== target) {
    git(['-c', `core.hooksPath=${path.join(path.dirname(logFile), 'empty-hooks')}`, 'merge', '--ff-only', target], upstream, { env, logFile })
  }
  assertClean(upstream, 'upstream checkout after fetch', env, logFile)
  return { target, incoming }
}

function acceptedTarget({ upstream, previousTarget, manifest, env, logFile }) {
  const target = previousTarget
  git(['cat-file', '-e', `${target}^{commit}`], upstream, { env, logFile })
  ancestry(upstream, manifest.upstream.release_floor, target, env, 'release floor', logFile)
  ancestry(upstream, manifest.upstream.tested_base, target, env, 'canonical tested base', logFile)
  const remoteTarget = gitText(['rev-parse', 'refs/remotes/upstream/main^{commit}'], upstream, { env, logFile })
  ancestry(upstream, target, remoteTarget, env, 'accepted target against stored upstream main', logFile)
  return {
    target,
    incoming: null,
    freshness: 'accepted-target-no-network',
  }
}

function createCandidate({ upstream, accepted, store, oldTip, target, id, manifest, dependencyContract, runRoot, env, checks }) {
  const candidate = path.join(runRoot, 'candidate')
  const replayLog = path.join(runRoot, 'logs/replay.log')
  git(['clone', '--no-hardlinks', '--no-checkout', upstream, candidate], workflowRoot, { env, logFile: replayLog })
  if (fs.existsSync(path.join(candidate, '.git/objects/info/alternates'))) fail('candidate may not use object alternates')
  git(['remote', 'remove', 'origin'], candidate, { env, logFile: replayLog })
  git(['checkout', '-b', manifest.source.branch, target], candidate, { env, logFile: replayLog })
  git(['config', 'user.name', 'GatherLocal sync replay'], candidate, { env, logFile: replayLog })
  git(['config', 'user.email', 'gatherlocal-sync@invalid.local'], candidate, { env, logFile: replayLog })
  git(['config', 'commit.gpgsign', 'false'], candidate, { env, logFile: replayLog })
  git(['config', 'push.default', 'nothing'], candidate, { env, logFile: replayLog })
  git(['config', 'core.hooksPath', path.join(workflowRoot, '.githooks')], candidate, { env, logFile: replayLog })
  git(['remote', 'add', 'upstream', UPSTREAM_URL], candidate, { env, logFile: replayLog })
  git(['remote', 'set-url', '--push', 'upstream', 'DISABLED'], candidate, { env, logFile: replayLog })
  git(['config', 'remote.upstream.fetch', '+refs/heads/main:refs/remotes/upstream/main'], candidate, { env, logFile: replayLog })
  git([
    'fetch', '--no-tags', '--no-write-fetch-head', store,
    `${manifest.source.canonical_evidence_ref}:${manifest.source.canonical_evidence_ref}`,
  ], candidate, { env, logFile: replayLog })
  git([
    'fetch', '--no-tags', '--no-write-fetch-head', accepted,
    `refs/heads/${manifest.source.branch}:refs/gatherlocal/recovery/${id}`,
  ], candidate, { env, logFile: replayLog })
  cloneDependencySnapshot(accepted, candidate, dependencyContract, { verifyCandidatePackage: false, env })

  const replay = []
  for (const patch of manifest.patches) {
    const started = Date.now()
    git(['am', '--3way', path.join(workflowRoot, patch.artifact)], candidate, { env, logFile: replayLog })
    const commit = gitText(['rev-parse', 'HEAD'], candidate, { env, logFile: replayLog })
    const tree = gitText(['rev-parse', 'HEAD^{tree}'], candidate, { env, logFile: replayLog })
    const patchId = stablePatchId(commit, candidate, env, replayLog)
    if (patchId !== patch.patch_id_stable) fail(`${patch.id}: replay stable patch ID mismatch`)
    if (gitText(['log', '-1', '--format=%s', commit], candidate, { env, logFile: replayLog }) !== patch.subject) {
      fail(`${patch.id}: replay subject mismatch`)
    }
    replay.push({ id: patch.id, commit, tree, stable_patch_id: patchId })
    for (const check of patch.checks) {
      const checkLog = path.join(runRoot, `logs/scoped-${check.id}.log`)
      run(check.argv[0], check.argv.slice(1), {
        cwd: candidate,
        env: { ...env, ...check.env },
        logFile: checkLog,
      })
      checks.push({ id: `scoped.${check.id}`, status: 'pass', duration_ms: Date.now() - started, log: path.basename(checkLog) })
    }
  }
  verifyDependencySnapshot(candidate, dependencyContract, { env })
  assertClean(candidate, 'replayed candidate', env, replayLog)
  const tip = gitText(['rev-parse', 'HEAD'], candidate, { env, logFile: replayLog })
  const tree = gitText(['rev-parse', 'HEAD^{tree}'], candidate, { env, logFile: replayLog })
  return { candidate, replay, tip, tree }
}

function runGate(checks, id, logFile, action) {
  const started = Date.now()
  const value = action()
  checks.push({ id, status: 'pass', duration_ms: Date.now() - started, log: path.basename(logFile) })
  return value
}

function validateCandidate({ candidate, descriptorFile, previousTarget, target, manifest, runRoot, env, checks, id }) {
  const finalLog = path.join(runRoot, 'logs/final-validation.log')
  runGate(checks, 'git.diff-check', finalLog, () => git(['diff', '--check', target, 'HEAD'], candidate, { env, logFile: finalLog }))
  runGate(checks, 'git.fsck', finalLog, () => git(['fsck', '--no-reflogs', '--full'], candidate, { env, logFile: finalLog }))
  runGate(checks, 'candidate.descriptor', finalLog, () => verifyCandidateDescriptor({
    file: descriptorFile, workflowRoot, appSource: candidate, manifest, env,
  }))

  const testFiles = fs.readdirSync(path.join(candidate, 'test'))
    .filter(name => name.endsWith('.test.js')).sort().map(name => `test/${name}`)
  const testLog = path.join(runRoot, 'logs/full-electron-tests.log')
  runGate(checks, 'app.electron-tests', testLog, () => run('./node_modules/.bin/electron', ['--test', ...testFiles], {
    cwd: candidate,
    env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    logFile: testLog,
  }))

  const serverChanged = [
    gitText(['diff', '--name-only', previousTarget, target, '--', 'server'], candidate, { env, logFile: finalLog }),
    gitText(['diff', '--name-only', target, 'HEAD', '--', 'server'], candidate, { env, logFile: finalLog }),
  ].some(value => value !== '')
  if (serverChanged) {
    if (!fs.existsSync(path.join(candidate, 'server/node_modules/.bin/tsc'))) {
      fail('overlay affects server but no pinned server dependency snapshot exists')
    }
    const serverLog = path.join(runRoot, 'logs/server-typecheck.log')
    runGate(checks, 'server.typecheck', serverLog, () => run('npm', ['run', 'typecheck'], {
      cwd: path.join(candidate, 'server'), env, logFile: serverLog,
    }))
  } else {
    checks.push({ id: 'server.typecheck', status: 'not-applicable', reason: 'upstream delta and overlay do not modify server' })
  }

  const rendererLog = path.join(runRoot, 'logs/renderer-build.log')
  runGate(checks, 'app.renderer-build', rendererLog, () => run('npm', ['run', 'build:renderer'], {
    cwd: candidate, env, logFile: rendererLog,
  }))
  const extensionLog = path.join(runRoot, 'logs/extension-package.log')
  runGate(checks, 'extension.package', extensionLog, () => {
    run('npm', ['run', 'pack:extension'], { cwd: candidate, env, logFile: extensionLog })
    run('/usr/bin/unzip', ['-t', 'dist/gatherlocal-extension.zip'], { cwd: candidate, env, logFile: extensionLog })
  })

  const packageLog = path.join(runRoot, 'logs/app-package.log')
  runGate(checks, 'app.package-arm64', packageLog, () => run('./node_modules/.bin/electron-builder', [
    '--dir', '--mac', '--arm64', '--publish', 'never', '--config.mac.identity=null',
    '--config.electronDist=node_modules/electron/dist',
  ], {
    cwd: candidate,
    env: {
      ...env,
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
      GATHERLOCAL_NOTARIZE: '0',
      SKIP_NOTARIZE: '1',
    },
    logFile: packageLog,
    timeout: 20 * 60_000,
  }))
  const appBundle = path.join(candidate, 'dist/build/mac-arm64/GatherLocal.app')
  runGate(checks, 'app.adhoc-sign', packageLog, () => run('/usr/bin/codesign', [
    '--force', '--deep', '--sign', '-', '--options', 'runtime',
    '--entitlements', 'build/entitlements.mac.plist', appBundle,
  ], { cwd: candidate, env, logFile: packageLog, timeout: 5 * 60_000 }))
  const appZip = path.join(candidate, 'dist/GatherLocal-mac-arm64-verified.zip')
  runGate(checks, 'app.archive', packageLog, () => {
    run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appBundle, appZip], {
      cwd: candidate, env, logFile: packageLog, timeout: 5 * 60_000,
    })
    run('/usr/bin/unzip', ['-t', appZip], { cwd: candidate, env, logFile: packageLog })
  })
  const packageVerifyLog = path.join(runRoot, 'logs/package-verify.log')
  const packageReceipt = runGate(checks, 'app.package-verify', packageVerifyLog, () => verifyPackagedApp({
    workflowRoot, appSource: candidate, descriptorFile, manifest, env,
  }))
  packageReceipt.distributable_zip = {
    path: path.relative(candidate, appZip),
    sha256: sha256File(appZip),
  }

  const dataReceipt = path.join(workflowRoot, 'runs', `sync-${id}-data-rehearsal.json`)
  const dataLog = path.join(runRoot, 'logs/data-rehearsal.log')
  const asar = path.join(candidate, 'dist/build/mac-arm64/GatherLocal.app/Contents/Resources/app.asar')
  runGate(checks, 'data.packaged-rehearsal', dataLog, () => run('node', [
    path.join(workflowRoot, 'scripts/verify-data-rehearsal.mjs'),
    '--app-source', candidate,
    '--runtime-root', asar,
    '--candidate-descriptor', descriptorFile,
    '--receipt', dataReceipt,
  ], { cwd: workflowRoot, env, logFile: dataLog, timeout: 10 * 60_000 }))
  runGate(checks, 'candidate.final-reverify', finalLog, () => verifyCandidateDescriptor({
    file: descriptorFile, workflowRoot, appSource: candidate, manifest, env,
  }))
  const data = JSON.parse(fs.readFileSync(dataReceipt, 'utf8'))
  assertEqual(data.source?.runtime?.sha256, packageReceipt.asar_sha256, 'packaged data-rehearsal ASAR')
  return {
    packageReceipt,
    dataReceipt,
    extension: {
      path: 'dist/gatherlocal-extension.zip',
      sha256: sha256File(path.join(candidate, 'dist/gatherlocal-extension.zip')),
    },
  }
}

function freezeReconstruction({ candidate, descriptorFile, manifest, dependencyContract, packageReceipt, extension, dataReceipt, env }) {
  const currentPackage = verifyPackagedApp({ workflowRoot, appSource: candidate, descriptorFile, manifest, env })
  assertEqual(currentPackage, {
    ...packageReceipt,
    distributable_zip: undefined,
  }, 'packaged app receipt')
  const data = JSON.parse(fs.readFileSync(dataReceipt, 'utf8'))
  const zip = path.join(candidate, packageReceipt.distributable_zip.path)
  const extensionFile = path.join(candidate, extension.path)
  return {
    dependencies: verifyDependencySnapshot(candidate, dependencyContract, { env }),
    app_bundle: treeInventory(path.join(candidate, packageReceipt.app_bundle), { includeContent: true }),
    package: packageReceipt,
    extension: { ...extension, sha256: sha256File(extensionFile) },
    data_rehearsal_receipt_sha256: sha256File(dataReceipt),
    packaged_runtime_sha256: data.source.runtime.sha256,
    distributable_zip_sha256: sha256File(zip),
  }
}

function createRecoveryEvidence({ store, candidate, descriptorFile, dataReceipt, runRoot, id, oldTip, newTip, previousTarget, target, upstreamFreshness, checks, packageReceipt, extension, reconstruction, env, logFile }) {
  const incomingRef = `refs/gatherlocal/incoming/${id}`
  git(['fetch', '--no-tags', '--no-write-fetch-head', candidate, `HEAD:${incomingRef}`], store, { env, logFile })
  if (gitText(['rev-parse', incomingRef], store, { env, logFile }) !== newTip) fail('acceptance incoming ref mismatch')
  const directory = path.join(paths.preservation, `GatherLocal-Sync-${id}`)
  fs.mkdirSync(directory)
  const bundle = path.join(directory, 'GatherLocal-Accepted.bundle')
  git(['bundle', 'create', bundle, '--all'], store, { env, logFile })
  verifyBundle(bundle, store, env, logFile)
  restoreBundle(bundle, path.join(runRoot, 'acceptance-restore.git'), env, logFile)
  fs.copyFileSync(descriptorFile, path.join(directory, 'candidate-descriptor.json'), fs.constants.COPYFILE_EXCL)
  fs.copyFileSync(dataReceipt, path.join(directory, 'data-rehearsal-receipt.json'), fs.constants.COPYFILE_EXCL)
  fs.cpSync(path.join(runRoot, 'logs'), path.join(directory, 'logs'), { recursive: true, errorOnExist: true })
  run('/usr/bin/zip', ['-rq', 'logs.zip', 'logs'], { cwd: directory, env, logFile })
  const receipt = {
    schema_version: 1,
    receipt_id: 'gatherlocal-sync',
    status: 'verified-awaiting-promotion',
    run_id: id,
    old_accepted_tip: oldTip,
    candidate_tip: newTip,
    previous_upstream_target: previousTarget,
    upstream_target: target,
    upstream_freshness: upstreamFreshness,
    checks,
    package: packageReceipt,
    extension,
    reconstruction,
    recovery_bundle_sha256: sha256File(bundle),
    created_at: new Date().toISOString(),
  }
  writeNewJson(path.join(directory, 'receipt.json'), receipt)
  return { directory, receipt, bundle }
}

function sealEvidence(evidence) {
  const receipt = evidence.receipt
  writeNewFile(path.join(evidence.directory, 'README.md'), [
    '# GatherLocal verified sync candidate',
    '',
    `Run: \`${receipt.run_id}\``,
    `Old accepted tip: \`${receipt.old_accepted_tip}\``,
    `Candidate tip: \`${receipt.candidate_tip}\``,
    `Upstream target: \`${receipt.upstream_target}\``,
    '',
    'All replay, scoped, full, package, and copied-data gates passed.',
    'Git refs determine whether this sealed candidate was promoted; this evidence is immutable.',
    '',
  ].join('\n'))
  writeNewFile(path.join(evidence.directory, 'SHA256SUMS'), checksumManifest(evidence.directory, [
    'GatherLocal-Accepted.bundle',
    'candidate-descriptor.json',
    'data-rehearsal-receipt.json',
    'receipt.json',
    'README.md',
    'logs.zip',
  ]))
}

function sync(id, runRoot, env, logFile, options) {
  ensureWorkflowBoundary(env, logFile)
  const manifest = loadAndVerifyManifest({ root: workflowRoot })
  const dependencyContract = loadDependencyContract(dependencyContractPath)
  const topology = validateTopology(manifest, dependencyContract, env, logFile)
  const journal = path.join(runRoot, 'promotion-journal.json')
  atomicWriteJson(journal, {
    schema_version: 1,
    run_id: id,
    phase: 'preflight',
    accepted_tip: topology.oldTip,
    previous_upstream_target: topology.previousTarget,
    pointer_repaired: topology.pointerRepaired,
  })
  const upstream = verifyUpstream(env, logFile)
  run('/usr/bin/shasum', ['-a', '256', '-c', 'SHA256SUMS'], {
    cwd: preservationSnapshot, env, logFile,
  })
  const fetched = options.command === 'rebuild'
    ? acceptedTarget({
      upstream,
      previousTarget: topology.previousTarget,
      manifest,
      env,
      logFile,
    })
    : {
      ...fetchTarget({
        upstream,
        id,
        expected: options.targetSha,
        previousTarget: topology.previousTarget,
        manifest,
        env,
        logFile,
      }),
      freshness: 'remote-main-verified',
    }

  const checks = []
  const candidateState = createCandidate({
    upstream,
    accepted: topology.accepted,
    store: topology.store,
    oldTip: topology.oldTip,
    target: fetched.target,
    id,
    manifest,
    dependencyContract,
    runRoot,
    env,
    checks,
  })
  const descriptor = createCandidateDescriptor({
    runId: id,
    workflowRoot,
    manifest,
    previousTarget: topology.previousTarget,
    target: fetched.target,
    upstreamFreshness: fetched.freshness,
    tip: candidateState.tip,
    tree: candidateState.tree,
    replay: candidateState.replay,
  })
  const descriptorFile = path.join(runRoot, 'candidate-descriptor.json')
  writeNewJson(descriptorFile, descriptor)
  const validation = validateCandidate({
    candidate: candidateState.candidate,
    descriptorFile,
    previousTarget: topology.previousTarget,
    target: fetched.target,
    manifest,
    runRoot,
    env,
    checks,
    id,
  })
  const reconstruction = freezeReconstruction({
    candidate: candidateState.candidate,
    descriptorFile,
    manifest,
    dependencyContract,
    packageReceipt: validation.packageReceipt,
    extension: validation.extension,
    dataReceipt: validation.dataReceipt,
    env,
  })
  const evidence = createRecoveryEvidence({
    store: topology.store,
    candidate: candidateState.candidate,
    descriptorFile,
    dataReceipt: validation.dataReceipt,
    runRoot,
    id,
    oldTip: topology.oldTip,
    newTip: candidateState.tip,
    previousTarget: topology.previousTarget,
    target: fetched.target,
    upstreamFreshness: fetched.freshness,
    checks,
    packageReceipt: validation.packageReceipt,
    extension: validation.extension,
    reconstruction,
    env,
    logFile,
  })
  sealEvidence(evidence)
  run('/usr/bin/shasum', ['-a', '256', '-c', 'SHA256SUMS'], {
    cwd: evidence.directory, env, logFile,
  })

  const immutablePath = path.join(paths.reconstructions, candidateState.tip)
  if (fs.existsSync(immutablePath)) fail('immutable reconstruction path already exists')
  atomicWriteJson(journal, {
    schema_version: 1, run_id: id, phase: 'verified',
    accepted_tip: topology.oldTip, candidate_tip: candidateState.tip,
    upstream_target: fetched.target, evidence: evidence.directory,
  })
  fs.renameSync(candidateState.candidate, immutablePath)
  assertClean(immutablePath, 'immutable candidate before promotion', env, logFile)
  if (gitText(['rev-parse', 'HEAD'], immutablePath, { env, logFile }) !== candidateState.tip) {
    fail('moved immutable candidate tip mismatch')
  }
  const movedReconstruction = freezeReconstruction({
    candidate: immutablePath,
    descriptorFile,
    manifest,
    dependencyContract,
    packageReceipt: validation.packageReceipt,
    extension: validation.extension,
    dataReceipt: validation.dataReceipt,
    env,
  })
  assertEqual(movedReconstruction, reconstruction, 'moved reconstruction receipt')
  if (fetched.incoming
    && gitText(['rev-parse', `${fetched.incoming}^{commit}`], upstream, { env, logFile }) !== fetched.target) {
    fail('incoming upstream ref changed before promotion')
  }
  atomicWriteJson(journal, {
    schema_version: 1, run_id: id, phase: 'candidate-staged',
    accepted_tip: topology.oldTip, candidate_tip: candidateState.tip,
    reconstruction: immutablePath, evidence: evidence.directory,
  })
  run('/bin/sync', [], { cwd: workspaceRoot, env, logFile })
  promoteRefs({
    store: topology.store,
    runId: id,
    oldTip: topology.oldTip,
    newTip: candidateState.tip,
    previousTarget: topology.previousTarget,
    target: fetched.target,
    canonicalTip: manifest.source.tip,
    env,
    logFile,
  })
  atomicWriteJson(journal, {
    schema_version: 1, run_id: id, phase: 'refs-promoted',
    accepted_tip: candidateState.tip, recovery_tip: topology.oldTip,
    reconstruction: immutablePath, evidence: evidence.directory,
  })
  atomicPointSymlink(paths.acceptedLink, immutablePath)
  const promotedReceipt = {
    ...evidence.receipt,
    status: 'accepted',
    accepted_ref: 'refs/gatherlocal/accepted',
    recovery_ref: `refs/gatherlocal/recovery/${id}`,
    reconstruction: path.relative(workspaceRoot, immutablePath),
    accepted_at: new Date().toISOString(),
    sealed_evidence_sha256: sha256File(path.join(evidence.directory, 'SHA256SUMS')),
  }
  atomicWriteJson(paths.state, promotedReceipt)
  run('/usr/bin/shasum', ['-a', '256', '-c', 'SHA256SUMS'], {
    cwd: evidence.directory, env, logFile,
  })
  atomicWriteJson(journal, {
    schema_version: 1, run_id: id, phase: 'complete',
    accepted_tip: candidateState.tip, recovery_tip: topology.oldTip,
    reconstruction: immutablePath, evidence: evidence.directory,
  })
  if (fetched.incoming) git(['update-ref', '-d', fetched.incoming, fetched.target], upstream, { env, logFile })
  return { ...promotedReceipt, evidence: evidence.directory }
}

const options = (() => {
  try {
    return parseSyncArguments(process.argv.slice(2))
  } catch (error) {
    console.error(`FAIL: ${error.message}`)
    console.error(`Usage: ${process.argv[1]} init | rebuild | sync --upstream-ref upstream/main [--target-sha FULL_SHA]`)
    process.exit(2)
  }
})()

const id = runId()
const runRoot = path.join(paths.controllerRuns, id)
let locked = false
let completed = false
const failureReceipt = {
  schema_version: 1,
  receipt_id: 'gatherlocal-sync-failure',
  run_id: id,
  command: options.command,
  status: 'failed',
  started_at: new Date().toISOString(),
}

try {
  if (!fs.existsSync(paths.controllerRuns)) fs.mkdirSync(paths.controllerRuns)
  physicalDirectory(paths.controllerRuns, 'controller run store')
  fs.mkdirSync(runRoot, { recursive: false })
  for (const directory of ['home', 'tmp', 'empty-hooks', 'logs']) {
    fs.mkdirSync(path.join(runRoot, directory))
  }
  const env = safeEnvironment(runRoot)
  scrubProcessEnvironment(env)
  const controllerLog = path.join(runRoot, 'logs/controller.log')
  acquireLock(paths.lock, id)
  locked = true
  const result = options.command === 'init'
    ? initializeTopology(id, runRoot, env, controllerLog)
    : sync(id, runRoot, env, controllerLog, options)
  completed = true
  console.log(`PASS: ${options.command} ${id}`)
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  failureReceipt.finished_at = new Date().toISOString()
  failureReceipt.error = error?.stack || error?.message || String(error)
  failureReceipt.failed_run = runRoot
  try {
    const journal = JSON.parse(fs.readFileSync(path.join(runRoot, 'promotion-journal.json'), 'utf8'))
    failureReceipt.promotion_phase = journal.phase
    failureReceipt.promotion_committed = ['refs-promoted', 'complete'].includes(journal.phase)
    failureReceipt.reconstruction = journal.reconstruction || null
  } catch {}
  try { writeNewJson(path.join(runRoot, 'failure-receipt.json'), failureReceipt) } catch {}
  console.error(`FAIL: ${error.message}`)
  console.error(`Failed run preserved: ${runRoot}`)
  process.exitCode = 1
} finally {
  if (locked) {
    try { releaseLock(paths.lock, id) } catch (error) {
      console.error(`FAIL: ${error.message}`)
      process.exitCode = 1
    }
  }
  if (completed && fs.existsSync(paths.lock)) {
    console.error('FAIL: sync lock remained after completion')
    process.exitCode = 1
  }
}
