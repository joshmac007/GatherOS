import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  authorizeNewJsonPath,
  macSandboxProfile,
  regularFileInside,
  resolveInside,
  sanitizedRunnerReceipt,
  treeInventory,
} from '../lib/data-rehearsal.mjs'

const workflowRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const appRoot = path.resolve(
  process.env.GATHERLOCAL_APP_SOURCE || path.join(workflowRoot, '..', 'GatherLocal-Next'),
)

test('owned rehearsal paths reject traversal and absolute paths', () => {
  assert.throws(() => resolveInside('/tmp/owner', '../escape'), /escapes its owner/)
  assert.throws(() => resolveInside('/tmp/owner', '/tmp/absolute'), /must be a non-empty relative path/)
  assert.equal(resolveInside('/tmp/owner', 'child/data'), '/tmp/owner/child/data')
})

test('critical files reject symlinked physical escapes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherlocal-path-test.'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherlocal-path-outside.'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  fs.writeFileSync(path.join(outside, 'database'), 'outside')
  fs.symlinkSync(outside, path.join(root, 'linked'))
  assert.throws(
    () => regularFileInside(root, 'linked/database', 'database'),
    /escapes its physical owner/,
  )
})

test('tree inventory includes regular files and symlinks without following them', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherlocal-inventory-test.'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'nested'))
  fs.writeFileSync(path.join(root, 'nested/file'), 'value')
  fs.symlinkSync('/does/not/exist', path.join(root, 'stale-link'))

  const inventory = treeInventory(root)
  assert.equal(inventory.count, 3)
  assert.match(inventory.sha256, /^[0-9a-f]{64}$/)
})

test('receipt authorization permits only new files in owned non-source roots', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherlocal-receipt-test.'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const owned = path.join(root, 'owned')
  const source = path.join(owned, 'source')
  const outside = path.join(root, 'outside')
  fs.mkdirSync(source, { recursive: true })
  fs.mkdirSync(outside)

  const valid = path.join(owned, 'receipt.json')
  assert.equal(authorizeNewJsonPath(valid, {
    allowedRoots: [owned],
    forbiddenRoots: [source],
  }), path.join(fs.realpathSync(owned), 'receipt.json'))
  assert.throws(
    () => authorizeNewJsonPath(path.join(source, 'receipt.json'), {
      allowedRoots: [owned],
      forbiddenRoots: [source],
    }),
    /protected source root/,
  )
  assert.throws(
    () => authorizeNewJsonPath(path.join(outside, 'receipt.json'), {
      allowedRoots: [owned],
    }),
    /outside workflow-owned evidence roots/,
  )
  fs.writeFileSync(valid, 'existing')
  assert.throws(
    () => authorizeNewJsonPath(valid, { allowedRoots: [owned] }),
    /refusing to overwrite/,
  )
})

test('macOS sandbox permits writes only inside disposable run root', { skip: process.platform !== 'darwin' }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherlocal-sandbox-test.'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherlocal-sandbox-outside.'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  const profile = macSandboxProfile(root)
  const allowed = path.join(root, 'allowed')
  const denied = path.join(outside, 'denied')

  assert.equal(spawnSync('/usr/bin/sandbox-exec', [
    '-p', profile, '/usr/bin/touch', allowed,
  ]).status, 0)
  assert.equal(fs.existsSync(allowed), true)
  assert.notEqual(spawnSync('/usr/bin/sandbox-exec', [
    '-p', profile, '/usr/bin/touch', denied,
  ]).status, 0)
  assert.equal(fs.existsSync(denied), false)
})

test('preserved receipts never retain disposable absolute backup paths', () => {
  const sanitized = sanitizedRunnerReceipt({
    migration_report: {
      upstream: { from: 15, to: 15 },
      adopted: [],
      applied: [],
      backupPath: '/tmp/private-run/library/moodmark.db.pre-local-migrate.1.bak',
    },
    total_changes: 0,
    inspection: {},
    loaded_app_modules: [],
    blocked_attempts: [],
    listening_handles: [],
  })
  assert.equal(
    sanitized.migration_report.backupPath,
    'moodmark.db.pre-local-migrate.1.bak',
  )
  assert.doesNotMatch(JSON.stringify(sanitized), /private-run/)
})

test('production and rehearsal use the same persistent-state seam', () => {
  const indexSource = fs.readFileSync(path.join(appRoot, 'src/main/index.js'), 'utf8')
  const runnerSource = fs.readFileSync(
    path.join(workflowRoot, 'scripts/data-rehearsal-entry.cjs'),
    'utf8',
  )
  assert.match(indexSource, /require\('\.\/persistent-state'\)/)
  assert.match(indexSource, /initializePersistentState\(\);/)
  assert.match(runnerSource, /src\/main\/persistent-state/)
  assert.doesNotMatch(runnerSource, /src\/main\/index/)
})

test('data contract binds the preservation DB without storing user content', () => {
  const contract = JSON.parse(fs.readFileSync(
    path.join(workflowRoot, 'manifests/data-rehearsal.v1.json'),
    'utf8',
  ))
  assert.equal(
    contract.snapshot.key_files['libraries/library_default/moodmark.db'],
    '494eb282c277f4597f5905fb6f8f8ad05c6c637e2895fecbebb7baa65205e8d2',
  )
  assert.equal(
    contract.snapshot.checksum_manifest_sha256,
    '05291efbfe385b6334553ad016742ca5b527b77fdf65ca9c0a6999a80ed2c0b7',
  )
  assert.equal(contract.before.save_count, 174)
  assert.equal(
    contract.before.mapped_media_sha256,
    '5fdc9cb15bd71fd4c39a4da00d9c91816605d3d67649e36c8e89eb533963119a',
  )
  assert.equal(contract.after.ledger.length, 7)
  assert.equal(
    contract.after.source_key_claims_sha256,
    '8310ab9e996c5ec157bb6f6ce6e3e0fff14c879c66c286432cde818c73d15cb5',
  )
  assert.equal(contract.snapshot.prefs, undefined)
  assert.equal(contract.before.rows, undefined)
  assert.equal(contract.before.values, undefined)
})
