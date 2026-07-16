import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  createCandidateDescriptor,
  verifyCandidateDescriptor,
} from '../lib/candidate-descriptor.mjs'
import { loadAndVerifyManifest } from '../lib/manifest.mjs'

const workflowRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workspaceRoot = path.resolve(workflowRoot, '..')
const evidenceStore = path.join(workspaceRoot, 'GatherLocal-Accepted.git')
const upstream = path.join(workspaceRoot, 'GatherOS-Upstream')

function run(args, cwd) {
  const result = spawnSync(args[0], args.slice(1), { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${args.join(' ')} failed: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

function buildCandidate(t, manifest) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherlocal-descriptor-candidate.'))
  const appRoot = path.join(directory, 'candidate')
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  run(['git', 'clone', '--no-hardlinks', '--no-checkout', upstream, appRoot], workflowRoot)
  run(['git', 'checkout', '-b', manifest.source.branch, manifest.upstream.tested_base], appRoot)
  run(['git', 'config', 'user.name', 'Descriptor test'], appRoot)
  run(['git', 'config', 'user.email', 'descriptor@invalid.local'], appRoot)
  for (const patch of manifest.patches) {
    run(['git', 'am', '--3way', path.join(workflowRoot, patch.artifact)], appRoot)
  }
  run([
    'git', 'fetch', '--no-tags', '--no-write-fetch-head', evidenceStore,
    `${manifest.source.canonical_evidence_ref}:${manifest.source.canonical_evidence_ref}`,
  ], appRoot)
  const commits = run(['git', 'rev-list', '--reverse', `${manifest.upstream.tested_base}..HEAD`], appRoot)
    .split('\n').filter(Boolean)
  return {
    appRoot,
    tip: run(['git', 'rev-parse', 'HEAD'], appRoot),
    tree: run(['git', 'rev-parse', 'HEAD^{tree}'], appRoot),
    replay: manifest.patches.map((patch, index) => ({
      id: patch.id,
      commit: commits[index],
      tree: run(['git', 'rev-parse', `${commits[index]}^{tree}`], appRoot),
      stable_patch_id: patch.patch_id_stable,
    })),
  }
}

test('descriptor freezes and re-verifies exact candidate history', (t) => {
  const manifest = loadAndVerifyManifest({ root: workflowRoot, source: evidenceStore })
  const candidate = buildCandidate(t, manifest)
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gatherlocal-descriptor-test.')), 'candidate.json')
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }))
  const descriptor = createCandidateDescriptor({
    runId: 'test-current-overlay',
    workflowRoot,
    manifest,
    previousTarget: manifest.upstream.tested_base,
    target: manifest.upstream.tested_base,
    tip: candidate.tip,
    tree: candidate.tree,
    replay: candidate.replay,
  })
  fs.writeFileSync(file, `${JSON.stringify(descriptor, null, 2)}\n`)
  const verified = verifyCandidateDescriptor({
    file,
    workflowRoot,
    appSource: candidate.appRoot,
    manifest,
  })
  assert.equal(verified.descriptor.candidate.tip, candidate.tip)
  assert.match(verified.descriptor_sha256, /^[0-9a-f]{64}$/)
})

test('descriptor rejects a substituted candidate tree', (t) => {
  const manifest = loadAndVerifyManifest({ root: workflowRoot, source: evidenceStore })
  const candidate = buildCandidate(t, manifest)
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherlocal-descriptor-drift.'))
  const file = path.join(directory, 'candidate.json')
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const descriptor = createCandidateDescriptor({
    runId: 'test-drift',
    workflowRoot,
    manifest,
    previousTarget: manifest.upstream.tested_base,
    target: manifest.upstream.tested_base,
    tip: candidate.tip,
    tree: candidate.tree,
    replay: candidate.replay,
  })
  descriptor.candidate.tree = '0'.repeat(40)
  fs.writeFileSync(file, `${JSON.stringify(descriptor, null, 2)}\n`)
  assert.throws(
    () => verifyCandidateDescriptor({ file, workflowRoot, appSource: candidate.appRoot, manifest }),
    /candidate tree mismatch/,
  )
})
