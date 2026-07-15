#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertEqual,
  assertInspectionHealthy,
  assertProtectedStateEqual,
  authorizeNewJsonPath,
  macSandboxProfile,
  regularFileInside,
  resolveInside,
  sanitizedRunnerReceipt,
  sha256File,
  treeInventory,
} from '../lib/data-rehearsal.mjs'
import { verifyCandidateDescriptor } from '../lib/candidate-descriptor.mjs'
import { loadAndVerifyManifest } from '../lib/manifest.mjs'

const workflowRoot = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'))
const workspaceRoot = fs.realpathSync(path.resolve(workflowRoot, '..'))
const contractPath = path.join(workflowRoot, 'manifests/data-rehearsal.v1.json')
const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'))
let appSource = path.join(workspaceRoot, 'GatherLocal-Next')
let runtimeRoot = null
let descriptorPath = null
let receiptPath = path.join(workflowRoot, 'runs', 'data-rehearsal-latest.json')
let keep = false

for (let index = 2; index < process.argv.length; index += 1) {
  const flag = process.argv[index]
  if (flag === '--keep') {
    keep = true
    continue
  }
  const value = process.argv[index + 1]
  if (!['--app-source', '--runtime-root', '--candidate-descriptor', '--receipt'].includes(flag) || !value) {
    console.error(`Usage: ${process.argv[1]} [--app-source PATH] [--runtime-root PATH] [--candidate-descriptor PATH] [--receipt PATH] [--keep]`)
    process.exit(2)
  }
  if (flag === '--app-source') appSource = path.resolve(value)
  if (flag === '--runtime-root') runtimeRoot = path.resolve(value)
  if (flag === '--candidate-descriptor') descriptorPath = path.resolve(value)
  if (flag === '--receipt') receiptPath = path.resolve(value)
  index += 1
}

function fail(message) {
  throw new Error(message)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout || 5 * 60 * 1000,
  })
  if (result.error) fail(`${command} failed: ${result.error.message}`)
  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} failed\n${(result.stderr || result.stdout).trim()}`)
  }
  return result.stdout.trim()
}

function git(args, cwd) {
  return run('git', args, { cwd })
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
  try {
    fs.linkSync(temporary, file)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

function verifyPreservationChecksums(snapshotRoot) {
  const checksumFile = path.join(snapshotRoot, 'SHA256SUMS')
  if (sha256File(checksumFile) !== contract.snapshot.checksum_manifest_sha256) {
    fail('preservation checksum manifest changed')
  }
  const lines = fs.readFileSync(checksumFile, 'utf8').trim().split(/\r?\n/)
  const results = []
  for (const line of lines) {
    const match = line.match(/^([0-9a-f]{64})  (.+)$/)
    if (!match) fail(`invalid preservation checksum line: ${line}`)
    const file = resolveInside(snapshotRoot, match[2], 'preservation checksum path')
    const actual = sha256File(file)
    if (actual !== match[1]) fail(`preservation checksum changed: ${match[2]}`)
    results.push([match[2], actual])
  }
  return {
    count: results.length,
    sha256: hashJson(results),
  }
}

function hashJson(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function keyFileHashes(root) {
  const result = {}
  for (const [relative, expected] of Object.entries(contract.snapshot.key_files)) {
    const actual = sha256File(regularFileInside(root, relative, 'key file'))
    if (actual !== expected) fail(`key file checksum mismatch: ${relative}`)
    result[relative] = actual
  }
  return result
}

function nonDatabaseKeyHashes(root) {
  const result = {}
  for (const [relative, expected] of Object.entries(contract.snapshot.key_files)) {
    if (relative === contract.snapshot.database_relative) continue
    const actual = sha256File(regularFileInside(root, relative, 'non-database key file'))
    if (actual !== expected) fail(`non-database key file checksum mismatch: ${relative}`)
    result[relative] = actual
  }
  return result
}

function databaseArtifactExclusion(relative, type) {
  if (type === 'directory') return false
  const databaseRelative = contract.snapshot.database_relative
  const databaseDirectory = path.dirname(databaseRelative)
  return path.dirname(relative) === databaseDirectory
    && path.basename(relative).startsWith(path.basename(databaseRelative))
}

function backupInventory(userData) {
  const database = resolveInside(userData, contract.snapshot.database_relative, 'copied database')
  const directory = path.dirname(database)
  const base = path.basename(database)
  return fs.readdirSync(directory)
    .filter(name => name.startsWith(`${base}.pre-local-migrate.`) && name.endsWith('.bak'))
    .sort()
}

function inspect({ electron, executionRoot, runtimeRootPath, database, userData, output, hashMedia = false }) {
  const args = [
    path.join(workflowRoot, 'scripts/inspect-rehearsal-data.cjs'),
    '--app-source', runtimeRootPath,
    '--database', database,
    '--contract', contractPath,
    '--user-data', userData,
    '--output', output,
  ]
  if (hashMedia) args.push('--hash-media')
  run(electron, args, {
    cwd: executionRoot,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  return readJson(output)
}

function runStartup({ electron, executionRoot, runtimeRootPath, runRoot, userData, sentinel, label }) {
  const paths = {}
  for (const name of ['session', 'logs', 'crashes', 'home', 'tmp']) {
    paths[name] = path.join(runRoot, `${label}-${name}`)
    fs.mkdirSync(paths[name], { recursive: true })
  }
  const childReceipt = path.join(runRoot, `${label}-startup.json`)
  const env = {
    ...process.env,
    HOME: paths.home,
    TMPDIR: paths.tmp,
    GATHERLOCAL_REHEARSAL_APP_SOURCE: runtimeRootPath,
    GATHERLOCAL_REHEARSAL_CONTRACT: contractPath,
    GATHERLOCAL_REHEARSAL_USER_DATA: userData,
    GATHERLOCAL_REHEARSAL_RUN_ROOT: runRoot,
    GATHERLOCAL_REHEARSAL_SENTINEL: sentinel,
    GATHERLOCAL_REHEARSAL_RECEIPT: childReceipt,
    GATHERLOCAL_REHEARSAL_SESSION: paths.session,
    GATHERLOCAL_REHEARSAL_LOGS: paths.logs,
    GATHERLOCAL_REHEARSAL_CRASHES: paths.crashes,
    GATHERLOCAL_REHEARSAL_HOME: paths.home,
  }
  delete env.ELECTRON_RUN_AS_NODE
  const sandboxProfile = macSandboxProfile(runRoot)
  const result = spawnSync('/usr/bin/sandbox-exec', [
    '-p', sandboxProfile,
    electron,
    path.join(workflowRoot, 'scripts/data-rehearsal-entry.cjs'),
  ], {
    cwd: executionRoot,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 90 * 1000,
  })
  if (!fs.existsSync(childReceipt)) {
    fail(`${label} startup wrote no receipt: ${(result.stderr || result.stdout || '').trim()}`)
  }
  const receipt = readJson(childReceipt)
  if (result.error) fail(`${label} startup failed: ${result.error.message}`)
  if (result.status !== 0 || receipt.ok !== true) {
    fail(`${label} startup failed: ${receipt.error || result.stderr || result.stdout}`)
  }
  return receipt
}

function assertBefore(inspection) {
  assertInspectionHealthy(inspection, 'before')
  assertEqual(inspection.user_version, contract.before.user_version, 'before user_version')
  assertEqual(inspection.save_count, contract.before.save_count, 'before save count')
  assertEqual(inspection.active_save_count, contract.before.active_save_count, 'before active save count')
  assertEqual(inspection.paths.cell_count, contract.before.path_cells, 'before path cells')
  assertEqual(inspection.paths.non_null_count, contract.before.non_null_paths, 'before non-null paths')
  assertEqual(inspection.paths.active_non_null_count, contract.before.active_non_null_paths, 'before active paths')
  assertEqual(inspection.paths.mapped_file_count, contract.before.non_null_paths, 'before mapped media')
  assertEqual(inspection.paths.media_sha256, contract.before.mapped_media_sha256, 'before mapped media content')
  assertEqual(inspection.ledger, [], 'before migration ledger')
  for (const [table, count] of Object.entries(contract.before.expected_table_counts)) {
    assertEqual(inspection.protected_tables[table]?.count, count, `before ${table} count`)
  }
}

function ledgerWithoutTimestamp(ledger) {
  return ledger.map(({ ordinal, id, checksum, origin }) => ({ ordinal, id, checksum, origin }))
}

function assertAfter(inspection, before, label) {
  assertInspectionHealthy(inspection, label)
  assertEqual(inspection.user_version, contract.after.user_version, `${label} user_version`)
  assertProtectedStateEqual(inspection, before, label)
  assertEqual(ledgerWithoutTimestamp(inspection.ledger), contract.after.ledger, `${label} ledger`)
  if (!inspection.ledger.every(row => Number.isInteger(row.applied_at) && row.applied_at >= 0)) {
    fail(`${label} ledger timestamp is invalid`)
  }
  assertEqual(inspection.source_keys?.active_claims, contract.after.active_source_key_claims, `${label} source-key claims`)
  assertEqual(inspection.source_keys?.eligible_rows, contract.after.eligible_social_rows, `${label} eligible social rows`)
  assertEqual(inspection.source_keys?.eligible_nulls, contract.after.eligible_duplicate_nulls, `${label} duplicate nulls`)
  assertEqual(inspection.source_keys?.duplicate_claims, 0, `${label} duplicate claims`)
  assertEqual(
    inspection.source_keys?.claims_sha256,
    contract.after.source_key_claims_sha256,
    `${label} exact source-key claims`,
  )
}

function authorizeReceiptPath(requested, snapshotRoot) {
  const runsRoot = path.join(workflowRoot, 'runs')
  if (!fs.existsSync(runsRoot)) fs.mkdirSync(runsRoot)
  const runsStat = fs.lstatSync(runsRoot)
  if (runsStat.isSymbolicLink() || !runsStat.isDirectory()
    || path.dirname(fs.realpathSync(runsRoot)) !== workflowRoot) {
    fail('workflow runs root is not a physical owned directory')
  }
  return authorizeNewJsonPath(requested, {
    allowedRoots: [
      runsRoot,
      path.join(workspaceRoot, 'Preservation'),
    ],
    forbiddenRoots: [snapshotRoot],
  })
}

let runRoot
const startedAt = new Date().toISOString()
const receipt = {
  schema_version: 1,
  contract_id: contract.contract_id,
  status: 'failed',
  started_at: startedAt,
}
let receiptAuthorized = false

try {
  if (contract.schema_version !== 1 || contract.contract_id !== 'gatherlocal-preserved-v21') {
    fail('unsupported data rehearsal contract')
  }
  if (process.platform !== 'darwin') fail('APFS clone rehearsal requires macOS')
  const appSourceInput = path.resolve(appSource)
  if (fs.lstatSync(appSourceInput).isSymbolicLink()) fail('app source may not be a symlink')
  appSource = fs.realpathSync(appSource)
  const runtimeInput = runtimeRoot ? path.resolve(runtimeRoot) : appSource
  const runtimeInputStat = fs.lstatSync(runtimeInput)
  if (runtimeInputStat.isSymbolicLink()
    || (!runtimeInputStat.isDirectory() && !runtimeInputStat.isFile())) {
    fail('runtime root must be a physical directory or app.asar file')
  }
  runtimeRoot = fs.realpathSync(runtimeInput)
  if (runtimeRoot !== appSource) {
    const relativeRuntime = path.relative(appSource, runtimeRoot)
    if (!relativeRuntime || relativeRuntime.startsWith('..') || path.isAbsolute(relativeRuntime)) {
      fail('packaged runtime must stay inside candidate source')
    }
    if (!runtimeInputStat.isFile() || path.basename(runtimeRoot) !== 'app.asar') {
      fail('separate runtime root must be a packaged app.asar file')
    }
  }
  const snapshotRoot = fs.realpathSync(resolveInside(workspaceRoot, contract.snapshot.root_relative, 'snapshot root'))
  const sourceUserData = fs.realpathSync(resolveInside(snapshotRoot, contract.snapshot.user_data_relative, 'snapshot user data'))
  receiptPath = authorizeReceiptPath(receiptPath, snapshotRoot)
  receiptAuthorized = true
  const sourceDatabase = regularFileInside(sourceUserData, contract.snapshot.database_relative, 'snapshot database')
  if (fs.lstatSync(sourceUserData).isSymbolicLink()) fail('snapshot user data may not be a symlink')

  const electron = path.join(appSource, 'node_modules/.bin/electron')
  if (!fs.existsSync(electron)) fail('candidate Electron runtime is missing')
  if (!fs.existsSync('/usr/bin/sandbox-exec')) fail('macOS sandbox-exec is missing')
  const sourceCommit = git(['rev-parse', 'HEAD'], appSource)
  const workflowCommit = git(['rev-parse', 'HEAD'], workflowRoot)
  const sourceStatus = git(['status', '--porcelain'], appSource)
  const workflowStatus = git(['status', '--porcelain'], workflowRoot)
  const overlay = loadAndVerifyManifest({ root: workflowRoot, source: appSource })
  const sourceTree = git(['rev-parse', 'HEAD^{tree}'], appSource)
  if (sourceStatus !== '') fail('candidate app source must be clean')
  if (workflowStatus !== '') fail('workflow repository must be clean')
  let upstreamBase = overlay.upstream.tested_base
  let candidateDescriptor = null
  if (descriptorPath) {
    candidateDescriptor = verifyCandidateDescriptor({
      file: descriptorPath,
      workflowRoot,
      appSource,
      manifest: overlay,
    })
    upstreamBase = candidateDescriptor.descriptor.upstream.target
  } else {
    assertEqual(sourceCommit, overlay.source.tip, 'candidate app commit')
    assertEqual(sourceTree, overlay.source.resulting_tree, 'candidate app tree')
  }

  const preservationBefore = verifyPreservationChecksums(snapshotRoot)
  const sourceKeysBefore = keyFileHashes(sourceUserData)
  const sourceInventoryBefore = treeInventory(sourceUserData, { includeMtime: true })

  runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherlocal-data-rehearsal.'))
  const copiedUserData = path.join(runRoot, 'userData')
  fs.mkdirSync(copiedUserData)
  run('/bin/cp', ['-cR', `${sourceUserData}/.`, `${copiedUserData}/`])
  const copiedPhysical = fs.realpathSync(copiedUserData)
  const sourceShape = treeInventory(sourceUserData)
  const copiedShape = treeInventory(copiedPhysical)
  assertEqual(copiedShape, sourceShape, 'complete copied user-data shape')
  const copiedKeysBefore = keyFileHashes(copiedPhysical)

  for (const directory of ['session', 'logs', 'crashes', 'home', 'tmp']) {
    fs.mkdirSync(path.join(runRoot, directory), { recursive: true })
  }
  const sentinelPath = path.join(runRoot, 'COPY_SENTINEL.json')
  writeJson(sentinelPath, {
    schema_version: 1,
    source_snapshot: contract.snapshot.root_relative,
    run_root_realpath: fs.realpathSync(runRoot),
    user_data_realpath: copiedPhysical,
    source_database_sha256: contract.snapshot.key_files[contract.snapshot.database_relative],
  })

  const copiedDatabase = regularFileInside(copiedPhysical, contract.snapshot.database_relative, 'copied database')
  const beforeInspection = inspect({
    electron,
    executionRoot: appSource,
    runtimeRootPath: runtimeRoot,
    database: copiedDatabase,
    userData: copiedPhysical,
    output: path.join(runRoot, 'before.json'),
    hashMedia: true,
  })
  assertBefore(beforeInspection)
  const backupsBefore = backupInventory(copiedPhysical)
  const nonDatabaseBefore = treeInventory(copiedPhysical, {
    includeMtime: true,
    exclude: databaseArtifactExclusion,
  })

  const firstRun = runStartup({
    electron,
    executionRoot: appSource,
    runtimeRootPath: runtimeRoot,
    runRoot: fs.realpathSync(runRoot),
    userData: copiedPhysical,
    sentinel: sentinelPath,
    label: 'first',
  })
  assertAfter(firstRun.inspection, beforeInspection, 'first startup')
  assertEqual(firstRun.migration_report?.adopted, contract.after.adopted, 'first adopted migrations')
  assertEqual(firstRun.migration_report?.applied, contract.after.applied, 'first applied migrations')
  if (!firstRun.migration_report?.backupPath) fail('first startup did not report a verified backup')
  if (!(firstRun.total_changes > 0)) fail('first startup reported no migration changes')
  assertEqual(firstRun.blocked_attempts, [], 'first blocked side effects')
  assertEqual(firstRun.listening_handles, [], 'first listening handles')

  const backupsAfterFirst = backupInventory(copiedPhysical)
  const newBackups = backupsAfterFirst.filter(name => !backupsBefore.includes(name))
  assertEqual(newBackups.length, 1, 'first new backup count')
  assertEqual(path.basename(firstRun.migration_report.backupPath), newBackups[0], 'first reported backup')
  const backupInspection = inspect({
    electron,
    executionRoot: appSource,
    runtimeRootPath: runtimeRoot,
    database: path.join(path.dirname(copiedDatabase), newBackups[0]),
    userData: copiedPhysical,
    output: path.join(runRoot, 'backup.json'),
    hashMedia: true,
  })
  assertInspectionHealthy(backupInspection, 'verified backup')
  assertEqual(backupInspection.user_version, contract.before.user_version, 'backup user_version')
  assertEqual(backupInspection.schema_sha256, beforeInspection.schema_sha256, 'backup schema')
  assertProtectedStateEqual(backupInspection, beforeInspection, 'verified backup')
  assertEqual(backupInspection.ledger, [], 'backup migration ledger')

  const copiedKeysAfterFirst = nonDatabaseKeyHashes(copiedPhysical)
  const expectedNonDatabaseKeys = { ...copiedKeysBefore }
  delete expectedNonDatabaseKeys[contract.snapshot.database_relative]
  assertEqual(copiedKeysAfterFirst, expectedNonDatabaseKeys, 'first non-database key files')
  assertEqual(
    treeInventory(copiedPhysical, { includeMtime: true, exclude: databaseArtifactExclusion }),
    nonDatabaseBefore,
    'first non-database user-data inventory',
  )

  const secondRun = runStartup({
    electron,
    executionRoot: appSource,
    runtimeRootPath: runtimeRoot,
    runRoot: fs.realpathSync(runRoot),
    userData: copiedPhysical,
    sentinel: sentinelPath,
    label: 'second',
  })
  assertAfter(secondRun.inspection, firstRun.inspection, 'second startup')
  assertEqual(secondRun.inspection.schema_sha256, firstRun.inspection.schema_sha256, 'second schema')
  assertEqual(secondRun.inspection.ledger, firstRun.inspection.ledger, 'second full ledger')
  assertEqual(secondRun.inspection.source_keys, firstRun.inspection.source_keys, 'second source keys')
  assertEqual(secondRun.migration_report?.adopted, [], 'second adopted migrations')
  assertEqual(secondRun.migration_report?.applied, [], 'second applied migrations')
  assertEqual(secondRun.migration_report?.backupPath, null, 'second backup path')
  assertEqual(secondRun.total_changes, 0, 'second total changes')
  assertEqual(backupInventory(copiedPhysical), backupsAfterFirst, 'second backup inventory')
  assertEqual(secondRun.blocked_attempts, [], 'second blocked side effects')
  assertEqual(secondRun.listening_handles, [], 'second listening handles')
  assertEqual(
    treeInventory(copiedPhysical, { includeMtime: true, exclude: databaseArtifactExclusion }),
    nonDatabaseBefore,
    'second non-database user-data inventory',
  )
  assertEqual(nonDatabaseKeyHashes(copiedPhysical), expectedNonDatabaseKeys, 'second non-database key files')

  const preservationAfter = verifyPreservationChecksums(snapshotRoot)
  const sourceKeysAfter = keyFileHashes(sourceUserData)
  const sourceInventoryAfter = treeInventory(sourceUserData, { includeMtime: true })
  assertEqual(preservationAfter, preservationBefore, 'preservation checksum receipt')
  assertEqual(sourceKeysAfter, sourceKeysBefore, 'preservation key files')
  assertEqual(sourceInventoryAfter, sourceInventoryBefore, 'preservation source inventory')
  assertEqual(sha256File(sourceDatabase), contract.snapshot.key_files[contract.snapshot.database_relative], 'preservation database')

  receipt.status = 'pass'
  receipt.finished_at = new Date().toISOString()
  receipt.source = {
    app_commit: sourceCommit,
    app_status_clean: sourceStatus === '',
    workflow_commit: workflowCommit,
    workflow_status_clean: true,
    upstream_base: upstreamBase,
    candidate_descriptor_sha256: candidateDescriptor?.descriptor_sha256 || null,
    runtime: runtimeRoot === appSource
      ? { kind: 'source-tree', tree: sourceTree }
      : { kind: 'packaged-asar', sha256: sha256File(runtimeRoot) },
  }
  receipt.preservation = {
    snapshot: contract.snapshot.root_relative,
    checksum_manifest: preservationAfter,
    key_file_sha256: sourceKeysAfter,
    tree_inventory: sourceInventoryAfter,
  }
  receipt.copy = {
    tree_shape: copiedShape,
    media_sha256: beforeInspection.paths.media_sha256,
    mapped_media_count: beforeInspection.paths.mapped_file_count,
  }
  receipt.isolation = {
    os_sandbox: 'macOS sandbox-exec',
    network: 'denied',
    writable_scope: 'disposable run root only',
  }
  receipt.before = beforeInspection
  receipt.first_startup = sanitizedRunnerReceipt(firstRun)
  receipt.verified_backup = {
    filename: newBackups[0],
    inspection: backupInspection,
  }
  receipt.second_startup = sanitizedRunnerReceipt(secondRun)
  writeJson(receiptPath, receipt)

  console.log(`PASS: copied-data rehearsal receipt ${receiptPath}`)
  console.log(`PASS: ${beforeInspection.save_count} saves, ${beforeInspection.paths.mapped_file_count} mapped files, seven named migrations`)
  if (keep) console.log(`Candidate preserved: ${runRoot}`)
  if (!keep) fs.rmSync(runRoot, { recursive: true, force: true })
} catch (error) {
  receipt.finished_at = new Date().toISOString()
  receipt.error = error?.stack || error?.message || String(error)
  receipt.failed_candidate = runRoot || null
  if (receiptAuthorized) {
    try { writeJson(receiptPath, receipt) } catch {}
  }
  console.error(`FAIL: ${error.message}`)
  if (runRoot) console.error(`Failed candidate preserved: ${runRoot}`)
  process.exitCode = 1
}
