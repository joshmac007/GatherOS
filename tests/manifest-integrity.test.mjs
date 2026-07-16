import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadAndVerifyManifest } from '../lib/manifest.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = path.join(root, 'manifests/overlay.v1.json')
const source = path.resolve(
  process.env.GATHERLOCAL_OVERLAY_SOURCE || path.join(root, '..', 'GatherLocal-Accepted.git'),
)

function fixture(mutate) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherlocal-manifest-test.'))
  fs.mkdirSync(path.join(temporaryRoot, 'manifests'))
  fs.mkdirSync(path.join(temporaryRoot, 'patches'))
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  for (const patch of manifest.patches) {
    fs.copyFileSync(path.join(root, patch.artifact), path.join(temporaryRoot, patch.artifact))
  }
  mutate?.(manifest, temporaryRoot)
  fs.writeFileSync(
    path.join(temporaryRoot, 'manifests/overlay.v1.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  return temporaryRoot
}

function withFixture(mutate, check) {
  const temporaryRoot = fixture(mutate)
  try {
    check(temporaryRoot)
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
}

test('verifies artifact and current source evidence', () => {
  const manifest = loadAndVerifyManifest({ root, source })
  assert.equal(manifest.patches.length, 11)
  assert.equal(manifest.patches[1].contribution_state, 'pending-local-only')
  assert.equal(manifest.source.canonical_evidence_ref, 'refs/gatherlocal/evidence/overlay-v1')
})

test('rejects modified artifact bytes', () => {
  withFixture(
    (manifest, temporaryRoot) => {
      fs.appendFileSync(path.join(temporaryRoot, manifest.patches[0].artifact), '\n')
    },
    temporaryRoot => {
      assert.throws(
        () => loadAndVerifyManifest({ root: temporaryRoot }),
        /artifact checksum mismatch/,
      )
    },
  )
})

test('rejects duplicate logical IDs', () => {
  withFixture(
    manifest => {
      manifest.patches[1].id = manifest.patches[0].id
    },
    temporaryRoot => {
      assert.throws(() => loadAndVerifyManifest({ root: temporaryRoot }), /duplicate patch id/)
    },
  )
})

test('rejects dependencies on later patches', () => {
  withFixture(
    manifest => {
      manifest.patches[0].logical_dependencies = [manifest.patches[1].id]
    },
    temporaryRoot => {
      assert.throws(() => loadAndVerifyManifest({ root: temporaryRoot }), /must refer to an earlier patch/)
    },
  )
})

test('rejects auto-drop policy on personal patches', () => {
  withFixture(
    manifest => {
      manifest.patches[0].acceptance_policy = manifest.acceptance.pending_contribution_policy
    },
    temporaryRoot => {
      assert.throws(() => loadAndVerifyManifest({ root: temporaryRoot }), /personal patch may not auto-drop/)
    },
  )
})

test('rejects unknown automatic adoption evidence', () => {
  withFixture(
    manifest => {
      manifest.acceptance.automatic_pending_evidence.push('looks-similar')
    },
    temporaryRoot => {
      assert.throws(() => loadAndVerifyManifest({ root: temporaryRoot }), /schema whitelist exactly/)
    },
  )
})

test('rejects undeclared patch artifacts', () => {
  withFixture(
    (_manifest, temporaryRoot) => {
      fs.writeFileSync(path.join(temporaryRoot, 'patches/9999-undeclared.patch'), 'not a patch\n')
    },
    temporaryRoot => {
      assert.throws(() => loadAndVerifyManifest({ root: temporaryRoot }), /artifact set differ/)
    },
  )
})
