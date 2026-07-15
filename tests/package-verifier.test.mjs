import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { verifyPackagedApp } from '../lib/package-verifier.mjs'

const workflowRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('package verifier rejects a missing candidate before launch', () => {
  assert.throws(
    () => verifyPackagedApp({
      workflowRoot,
      appSource: path.join(workflowRoot, 'missing-app'),
      descriptorFile: path.join(workflowRoot, 'missing-descriptor.json'),
      manifest: {},
    }),
    /ENOENT/,
  )
})
