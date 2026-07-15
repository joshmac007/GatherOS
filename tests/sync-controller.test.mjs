import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  atomicPointSymlink,
  git,
  gitText,
  parseSyncArguments,
  promoteRefs,
  safeEnvironment,
} from '../lib/sync-controller.mjs'

const OLD = '1'.repeat(40)
const NEW = '2'.repeat(40)

test('sync CLI accepts only explicit upstream/main and full target SHA', () => {
  assert.deepEqual(parseSyncArguments(['sync', '--upstream-ref', 'upstream/main', '--target-sha', OLD]), {
    command: 'sync', upstreamRef: 'upstream/main', targetSha: OLD,
  })
  assert.throws(() => parseSyncArguments(['sync', '--upstream-ref', 'HEAD']), /exactly upstream\/main/)
  assert.throws(() => parseSyncArguments(['sync', '--upstream-ref', 'v0.7.0']), /exactly upstream\/main/)
  assert.throws(() => parseSyncArguments(['sync', '--upstream-ref', 'upstream/main', '--target-sha', '527f926']), /full commit SHA/)
  assert.throws(() => parseSyncArguments([
    'sync', '--upstream-ref', 'upstream/main', '--upstream-ref', 'upstream/main',
  ]), /duplicate sync option/)
})

test('accepted ref transaction is atomic and rejects stale old tip', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherlocal-ref-test.'))
  const store = path.join(root, 'accepted.git')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'home'))
  fs.mkdirSync(path.join(root, 'tmp'))
  git(['init', '--bare', store], root)
  const env = safeEnvironment(root)
  const emptyTree = gitText(['mktree'], store, { input: '' })
  const oldTip = gitText(['commit-tree', emptyTree, '-m', 'old'], store, {
    env: { ...env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@invalid.local', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@invalid.local' },
  })
  const newTip = gitText(['commit-tree', emptyTree, '-p', oldTip, '-m', 'new'], store, {
    env: { ...env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@invalid.local', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@invalid.local' },
  })
  git(['update-ref', 'refs/gatherlocal/accepted', oldTip], store, { env })
  git(['update-ref', 'refs/gatherlocal/upstream/accepted', oldTip], store, { env })
  git(['update-ref', 'refs/gatherlocal/evidence/overlay-v1', oldTip], store, { env })
  git(['update-ref', 'refs/gatherlocal/incoming/20260714T120000Z-aaaaaaaa', newTip], store, { env })
  promoteRefs({
    store,
    runId: '20260714T120000Z-aaaaaaaa',
    oldTip,
    newTip,
    previousTarget: oldTip,
    target: newTip,
    canonicalTip: oldTip,
    env,
  })
  assert.equal(gitText(['rev-parse', 'refs/gatherlocal/accepted'], store), newTip)
  assert.equal(gitText(['rev-parse', 'refs/gatherlocal/recovery/20260714T120000Z-aaaaaaaa'], store), oldTip)
  assert.throws(() => promoteRefs({
    store,
    runId: '20260714T120001Z-bbbbbbbb',
    oldTip,
    newTip,
    previousTarget: oldTip,
    target: newTip,
    canonicalTip: oldTip,
    env,
  }), /failed/)
})

test('accepted convenience pointer atomically selects immutable reconstruction', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherlocal-pointer-test.'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const reconstructions = path.join(root, 'GatherLocal-Reconstructions')
  const oldPath = path.join(reconstructions, OLD)
  const newPath = path.join(reconstructions, NEW)
  fs.mkdirSync(oldPath, { recursive: true })
  fs.mkdirSync(newPath)
  const link = path.join(root, 'GatherLocal-Next')
  fs.symlinkSync(path.relative(root, oldPath), link, 'dir')
  atomicPointSymlink(link, newPath)
  assert.equal(fs.realpathSync(link), fs.realpathSync(newPath))
  assert.equal(fs.existsSync(oldPath), true)
})
