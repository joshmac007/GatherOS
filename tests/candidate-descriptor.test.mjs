import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  createCandidateDescriptor,
  verifyCandidateDescriptor,
} from '../lib/candidate-descriptor.mjs'
import { loadAndVerifyManifest } from '../lib/manifest.mjs'

const workflowRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifestFile = JSON.parse(fs.readFileSync(path.join(workflowRoot, 'manifests/overlay.v1.json'), 'utf8'))
const appRoot = path.resolve(process.env.GATHERLOCAL_APP_SOURCE || path.join(
  workflowRoot, '..', 'GatherLocal-Reconstructions', manifestFile.source.tip,
))

test('descriptor freezes and re-verifies exact candidate history', (t) => {
  const manifest = loadAndVerifyManifest({ root: workflowRoot, source: appRoot })
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gatherlocal-descriptor-test.')), 'candidate.json')
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }))
  const descriptor = createCandidateDescriptor({
    runId: 'test-current-overlay',
    workflowRoot,
    manifest,
    previousTarget: manifest.upstream.tested_base,
    target: manifest.upstream.tested_base,
    tip: manifest.source.tip,
    tree: manifest.source.resulting_tree,
    replay: manifest.patches.map(patch => ({
      id: patch.id,
      commit: patch.source_commit,
      tree: patch.source_tree,
      stable_patch_id: patch.patch_id_stable,
    })),
  })
  fs.writeFileSync(file, `${JSON.stringify(descriptor, null, 2)}\n`)
  const verified = verifyCandidateDescriptor({
    file,
    workflowRoot,
    appSource: appRoot,
    manifest,
  })
  assert.equal(verified.descriptor.candidate.tip, manifest.source.tip)
  assert.match(verified.descriptor_sha256, /^[0-9a-f]{64}$/)
})

test('descriptor rejects a substituted candidate tree', (t) => {
  const manifest = loadAndVerifyManifest({ root: workflowRoot, source: appRoot })
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherlocal-descriptor-drift.'))
  const file = path.join(directory, 'candidate.json')
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const descriptor = createCandidateDescriptor({
    runId: 'test-drift',
    workflowRoot,
    manifest,
    previousTarget: manifest.upstream.tested_base,
    target: manifest.upstream.tested_base,
    tip: manifest.source.tip,
    tree: manifest.source.resulting_tree,
    replay: manifest.patches.map(patch => ({
      id: patch.id,
      commit: patch.source_commit,
      tree: patch.source_tree,
      stable_patch_id: patch.patch_id_stable,
    })),
  })
  descriptor.candidate.tree = '0'.repeat(40)
  fs.writeFileSync(file, `${JSON.stringify(descriptor, null, 2)}\n`)
  assert.throws(
    () => verifyCandidateDescriptor({ file, workflowRoot, appSource: appRoot, manifest }),
    /candidate tree mismatch/,
  )
})
