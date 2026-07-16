import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildRevisionProposal } from '../scripts/intake-overlay.mjs'

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

function write(root, text) {
  fs.writeFileSync(path.join(root, 'feature.txt'), `${text}\n`)
  git(root, 'add', 'feature.txt')
}

function commit(root, subject) {
  git(root, 'commit', '-m', subject)
  return git(root, 'rev-parse', 'HEAD')
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherlocal-revision-test.'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  git(root, 'init')
  git(root, 'config', 'user.name', 'Test')
  git(root, 'config', 'user.email', 'test@invalid.local')
  git(root, 'config', 'push.default', 'nothing')
  write(root, 'base')
  const base = commit(root, 'Base')
  write(root, 'old behavior')
  const oldCommit = commit(root, 'Final feature')
  git(root, 'checkout', '--detach', base)
  write(root, 'corrected behavior')
  const revisedCommit = commit(root, 'Final feature')

  const checks = [{ id: 'feature-tests', argv: ['node', '--test', 'test/feature.test.js'] }]
  const dependencies = ['personal.foundation']
  const manifest = {
    source: { tip: oldCommit, resulting_tree: git(root, 'rev-parse', `${oldCommit}^{tree}`) },
    patches: [{
      order: 130,
      id: 'pending.final-feature',
      revision: 1,
      class: 'pending-contribution',
      contribution_state: 'pending-local-only',
      subject: 'Final feature',
      source_commit: oldCommit,
      source_parent: base,
      source_tree: git(root, 'rev-parse', `${oldCommit}^{tree}`),
      logical_dependencies: dependencies,
      patch_id_stable: '1'.repeat(40),
      canonical_diff_sha256: '2'.repeat(64),
      artifact: 'patches/0130-pending.final-feature.patch',
      artifact_sha256: '3'.repeat(64),
      acceptance_policy: 'exact-upstream-or-reviewed-contract',
      checks,
    }],
  }
  const spec = {
    schema_version: 1,
    expected_tip: oldCommit,
    workflow_commit_subject: 'Revise final feature patch',
    patches: [{
      id: 'pending.final-feature',
      revision: 2,
      class: 'pending-contribution',
      subject: 'Final feature',
      source_commit: revisedCommit,
      logical_dependencies: dependencies,
      checks,
    }],
  }
  return { root, base, oldCommit, revisedCommit, manifest, spec }
}

test('replaces final patch in place with exact next revision', (t) => {
  const data = fixture(t)
  const proposal = buildRevisionProposal(data.manifest, data.spec, data.root)
  const revised = proposal.manifest.patches.at(-1)

  assert.equal(proposal.manifest.patches.length, 1)
  assert.equal(revised.id, 'pending.final-feature')
  assert.equal(revised.order, 130)
  assert.equal(revised.revision, 2)
  assert.equal(revised.source_commit, data.revisedCommit)
  assert.equal(revised.source_parent, data.base)
  assert.equal(revised.artifact, 'patches/0130-pending.final-feature.patch')
  assert.equal(proposal.manifest.source.tip, data.revisedCommit)
  assert.equal(proposal.artifacts.length, 1)
  assert.equal(proposal.artifacts[0].relative, revised.artifact)
  assert.match(proposal.artifacts[0].bytes.toString('utf8'), new RegExp(`^From ${data.revisedCommit} `))
})

test('rejects stale, non-final, non-incremented, and multi-patch revisions', (t) => {
  const data = fixture(t)
  const mutate = callback => {
    const spec = structuredClone(data.spec)
    callback(spec)
    return spec
  }

  assert.throws(
    () => buildRevisionProposal(data.manifest, mutate(spec => { spec.expected_tip = data.base }), data.root),
    /expected_tip is stale/,
  )
  assert.throws(
    () => buildRevisionProposal(data.manifest, mutate(spec => { spec.patches[0].id = 'pending.other' }), data.root),
    /only the final patch id/,
  )
  assert.throws(
    () => buildRevisionProposal(data.manifest, mutate(spec => { spec.patches[0].revision = 1 }), data.root),
    /increment final patch revision by exactly one/,
  )
  assert.throws(
    () => buildRevisionProposal(data.manifest, mutate(spec => { spec.patches.push(spec.patches[0]) }), data.root),
    /exactly one patch/,
  )
})

test('rejects metadata drift and replacement from wrong parent', (t) => {
  const data = fixture(t)
  const changed = structuredClone(data.spec)
  changed.patches[0].checks[0].argv.push('--changed')
  assert.throws(() => buildRevisionProposal(data.manifest, changed, data.root), /revision checks mismatch/)

  git(data.root, 'checkout', '--detach', data.oldCommit)
  write(data.root, 'wrong chain')
  const wrongCommit = commit(data.root, 'Final feature')
  const wrong = structuredClone(data.spec)
  wrong.patches[0].source_commit = wrongCommit
  assert.throws(
    () => buildRevisionProposal(data.manifest, wrong, data.root),
    /source parent must equal original source parent/,
  )
})

test('rejects wrong source evidence and extra commits', (t) => {
  const data = fixture(t)
  write(data.root, 'extra commit')
  commit(data.root, 'Extra commit')
  assert.throws(
    () => buildRevisionProposal(data.manifest, data.spec, data.root),
    /extra commits are forbidden/,
  )

  const wrongManifest = structuredClone(data.manifest)
  wrongManifest.source.tip = '0'.repeat(40)
  wrongManifest.patches[0].source_commit = wrongManifest.source.tip
  const wrongSpec = structuredClone(data.spec)
  wrongSpec.expected_tip = wrongManifest.source.tip
  wrongSpec.patches[0].source_commit = git(data.root, 'rev-parse', 'HEAD')
  assert.throws(
    () => buildRevisionProposal(wrongManifest, wrongSpec, data.root),
    /does not contain current final patch evidence/,
  )
})
