import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  loadDependencyContract,
  verifyDependencySnapshot,
} from '../lib/dependencies.mjs'

const workflowRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const appRoot = path.resolve(
  process.env.GATHERLOCAL_APP_SOURCE || path.join(workflowRoot, '..', 'GatherLocal-Next'),
)
const contractPath = path.join(workflowRoot, 'manifests/dependencies.v1.json')

test('pinned dependency snapshot matches accepted reconstruction', () => {
  const contract = loadDependencyContract(contractPath)
  const receipt = verifyDependencySnapshot(appRoot, contract)
  assert.equal(receipt.tree.count, 26215)
  assert.equal(receipt.tools.electron, 'v41.10.1')
})

test('dependency contract rejects package-manifest drift before reuse', () => {
  const contract = loadDependencyContract(contractPath)
  const changed = structuredClone(contract)
  changed.package_json_sha256 = '0'.repeat(64)
  assert.throws(
    () => verifyDependencySnapshot(appRoot, changed, { verifyTools: false }),
    /package manifest mismatch/,
  )
})

test('dependency contract stores no install credentials', () => {
  const text = fs.readFileSync(contractPath, 'utf8')
  assert.doesNotMatch(text, /(token|password|authorization|_auth)/i)
})

test('dependency contract ignores only Finder metadata', () => {
  const contract = loadDependencyContract(contractPath)
  const changed = structuredClone(contract)
  changed.node_modules.ignored_names = ['.DS_Store', 'package.json']
  const file = path.join(workflowRoot, 'runs', 'invalid-dependency-contract.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(changed))
  try {
    assert.throws(() => loadDependencyContract(file), /ignore only Finder metadata/)
  } finally {
    fs.rmSync(file, { force: true })
  }
})
