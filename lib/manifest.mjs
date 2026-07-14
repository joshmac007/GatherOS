import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const SHA1 = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/
const ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/
const AUTOMATIC_PENDING_EVIDENCE = [
  'source-commit-is-ancestor-of-target',
  'stable-patch-id-reachable-from-target',
]
const REVIEWED_PENDING_EVIDENCE = [
  'contract-tests-pass-without-patch',
  'source-inspection-confirms-upstream-ownership',
]
const NEVER_ADOPTION_EVIDENCE = [
  'apply-conflict',
  'empty-application',
  'file-overlap',
  'reverse-apply',
]

function fail(message) {
  throw new Error(message)
}

function expect(condition, message) {
  if (!condition) fail(message)
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex')
}

function ownedPath(root, relative, label) {
  expect(typeof relative === 'string' && relative.length > 0, `${label} must be a relative path`)
  expect(!path.isAbsolute(relative), `${label} must not be absolute`)
  const full = path.resolve(root, relative)
  expect(full.startsWith(`${root}${path.sep}`), `${label} escapes workflow root`)
  return full
}

function runGit(args, { cwd, input, allowFailure = false } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    input,
    encoding: input === undefined ? 'utf8' : undefined,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (!allowFailure && result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString('utf8')
      : result.stderr || ''
    fail(`git ${args.join(' ')} failed: ${stderr.trim()}`)
  }
  return result
}

function gitText(args, cwd) {
  return runGit(args, { cwd }).stdout.trim()
}

function patchId(content) {
  const output = runGit(['patch-id', '--stable'], { input: content }).stdout.toString('utf8').trim()
  const id = output.split(/\s+/)[0]
  expect(SHA1.test(id), 'artifact did not produce one stable patch ID')
  return id
}

function checkStringArray(value, label) {
  expect(Array.isArray(value) && value.length > 0, `${label} must be a non-empty array`)
  for (const item of value) expect(typeof item === 'string' && item.length > 0, `${label} contains an invalid value`)
}

function expectExactArray(actual, expected, label) {
  checkStringArray(actual, label)
  expect(JSON.stringify(actual) === JSON.stringify(expected), `${label} must match the schema whitelist exactly`)
}

function verifySource(manifest, sourceRoot) {
  const source = fs.realpathSync(sourceRoot)
  expect(gitText(['status', '--porcelain'], source) === '', 'source reconstruction must be clean')
  expect(gitText(['rev-parse', manifest.source.branch], source) === manifest.source.tip, 'source branch does not match manifest tip')
  expect(gitText(['rev-parse', `${manifest.upstream.tested_base}^{commit}`], source) === manifest.upstream.tested_base, 'tested base is missing from source repository')
  expect(gitText(['rev-parse', `${manifest.upstream.release_floor}^{commit}`], source) === manifest.upstream.release_floor, 'release floor is missing from source repository')

  const ancestry = runGit(
    ['merge-base', '--is-ancestor', manifest.upstream.release_floor, manifest.upstream.tested_base],
    { cwd: source, allowFailure: true },
  )
  expect(ancestry.status === 0, 'tested base does not descend from release floor')

  for (const patch of manifest.patches) {
    expect(gitText(['rev-parse', `${patch.source_commit}^`], source) === patch.source_parent, `${patch.id}: source parent mismatch`)
    expect(gitText(['rev-parse', `${patch.source_commit}^{tree}`], source) === patch.source_tree, `${patch.id}: source tree mismatch`)
    expect(gitText(['log', '-1', '--format=%s', patch.source_commit], source) === patch.subject, `${patch.id}: source subject mismatch`)

    const diff = runGit(
      ['show', '--format=', '--full-index', '--binary', patch.source_commit],
      { cwd: source },
    ).stdout
    expect(sha256(diff) === patch.canonical_diff_sha256, `${patch.id}: canonical diff checksum mismatch`)
    expect(patchId(diff) === patch.patch_id_stable, `${patch.id}: source stable patch ID mismatch`)
  }
}

export function loadAndVerifyManifest({ root, manifestPath = 'manifests/overlay.v1.json', source } = {}) {
  expect(root, 'workflow root is required')
  const workflowRoot = fs.realpathSync(root)
  const fullManifestPath = ownedPath(workflowRoot, manifestPath, 'manifest path')
  expect(fs.lstatSync(fullManifestPath).isFile(), 'manifest must be a regular file')
  const manifest = JSON.parse(fs.readFileSync(fullManifestPath, 'utf8'))

  expect(manifest.schema_version === 1, 'schema_version must be 1')
  expect(manifest.stack_id === 'gatherlocal-personal-overlay', 'unexpected stack_id')
  expect(manifest.upstream?.repository === 'https://github.com/BrettfromDJ/GatherOS.git', 'unexpected upstream repository')
  expect(manifest.upstream?.remote === 'upstream', 'upstream remote must be upstream')
  expect(manifest.upstream?.branch === 'main', 'upstream branch must be main')
  expect(SHA1.test(manifest.upstream?.release_floor || ''), 'release_floor must be a full commit SHA')
  expect(SHA1.test(manifest.upstream?.tested_base || ''), 'tested_base must be a full commit SHA')
  expect(SHA1.test(manifest.source?.tip || ''), 'source tip must be a full commit SHA')
  expect(SHA1.test(manifest.source?.resulting_tree || ''), 'resulting tree must be a full tree SHA')
  expect(manifest.source?.repository_sibling === 'GatherLocal-Next', 'unexpected source repository sibling')
  expect(typeof manifest.source?.branch === 'string' && manifest.source.branch.length > 0, 'source branch is required')

  expect(manifest.acceptance?.personal_policy === 'never-auto-drop', 'personal policy must fail closed')
  expect(manifest.acceptance?.pending_contribution_policy === 'exact-upstream-or-reviewed-contract', 'pending contribution policy must fail closed')
  expectExactArray(manifest.acceptance?.automatic_pending_evidence, AUTOMATIC_PENDING_EVIDENCE, 'automatic pending evidence')
  expectExactArray(manifest.acceptance?.reviewed_pending_evidence, REVIEWED_PENDING_EVIDENCE, 'reviewed pending evidence')
  expectExactArray(manifest.acceptance?.never_adoption_evidence, NEVER_ADOPTION_EVIDENCE, 'never adoption evidence')

  expect(Array.isArray(manifest.patches) && manifest.patches.length > 0, 'patches must be a non-empty array')
  const ids = new Set()
  const artifacts = new Set()
  let previousOrder = 0
  let previousCommit = manifest.upstream.tested_base

  for (const patch of manifest.patches) {
    expect(Number.isInteger(patch.order) && patch.order > previousOrder, `${patch.id || 'patch'}: order must be strictly increasing`)
    expect(ID.test(patch.id || ''), `invalid patch id: ${patch.id || '<missing>'}`)
    expect(!ids.has(patch.id), `duplicate patch id: ${patch.id}`)
    expect(Number.isInteger(patch.revision) && patch.revision > 0, `${patch.id}: revision must be positive`)
    expect(['personal-overlay', 'pending-contribution', 'personal-support'].includes(patch.class), `${patch.id}: invalid class`)
    expect(typeof patch.subject === 'string' && patch.subject.length > 0, `${patch.id}: subject is required`)
    expect(SHA1.test(patch.source_commit || ''), `${patch.id}: source_commit must be a full SHA`)
    expect(SHA1.test(patch.source_parent || ''), `${patch.id}: source_parent must be a full SHA`)
    expect(SHA1.test(patch.source_tree || ''), `${patch.id}: source_tree must be a full SHA`)
    expect(patch.source_parent === previousCommit, `${patch.id}: source chain is not linear`)
    expect(SHA1.test(patch.patch_id_stable || ''), `${patch.id}: stable patch ID is invalid`)
    expect(SHA256.test(patch.canonical_diff_sha256 || ''), `${patch.id}: canonical diff checksum is invalid`)
    expect(SHA256.test(patch.artifact_sha256 || ''), `${patch.id}: artifact checksum is invalid`)
    expect(Array.isArray(patch.logical_dependencies), `${patch.id}: logical_dependencies must be an array`)

    const dependencySet = new Set()
    for (const dependency of patch.logical_dependencies) {
      expect(typeof dependency === 'string', `${patch.id}: dependency must be a string`)
      expect(!dependencySet.has(dependency), `${patch.id}: duplicate dependency ${dependency}`)
      expect(ids.has(dependency), `${patch.id}: dependency ${dependency} must refer to an earlier patch`)
      dependencySet.add(dependency)
    }

    if (patch.class === 'pending-contribution') {
      expect(patch.acceptance_policy === manifest.acceptance.pending_contribution_policy, `${patch.id}: pending acceptance policy mismatch`)
      expect(patch.contribution_state === 'pending-local-only', `${patch.id}: current contribution state must be pending-local-only`)
    } else {
      expect(patch.acceptance_policy === manifest.acceptance.personal_policy, `${patch.id}: personal patch may not auto-drop`)
      expect(patch.contribution_state === undefined, `${patch.id}: personal patch cannot have contribution state`)
    }

    expect(Array.isArray(patch.checks) && patch.checks.length > 0, `${patch.id}: at least one scoped check is required`)
    for (const check of patch.checks) {
      expect(ID.test(check.id || ''), `${patch.id}: invalid check id`)
      expect(Array.isArray(check.argv) && check.argv.length > 0, `${patch.id}: check argv is required`)
      for (const arg of check.argv) expect(typeof arg === 'string' && arg.length > 0, `${patch.id}: check argv contains an invalid value`)
      if (check.env !== undefined) {
        expect(check.env && typeof check.env === 'object' && !Array.isArray(check.env), `${patch.id}: check env must be an object`)
        for (const [key, value] of Object.entries(check.env)) {
          expect(/^[A-Z_][A-Z0-9_]*$/.test(key), `${patch.id}: check env contains an invalid key`)
          expect(typeof value === 'string', `${patch.id}: check env values must be strings`)
        }
      }
    }

    expect(!artifacts.has(patch.artifact), `${patch.id}: duplicate artifact path`)
    expect(patch.artifact.startsWith(`patches/${String(patch.order).padStart(4, '0')}-`), `${patch.id}: artifact filename must encode patch order`)
    expect(patch.artifact.endsWith('.patch'), `${patch.id}: artifact must use .patch extension`)
    const artifactPath = ownedPath(workflowRoot, patch.artifact, `${patch.id} artifact`)
    const artifactStat = fs.lstatSync(artifactPath)
    expect(artifactStat.isFile() && !artifactStat.isSymbolicLink(), `${patch.id}: artifact must be a regular non-symlink file`)
    const realArtifactPath = fs.realpathSync(artifactPath)
    expect(realArtifactPath.startsWith(`${workflowRoot}${path.sep}`), `${patch.id}: artifact resolves outside workflow root`)
    const artifact = fs.readFileSync(artifactPath)
    expect(sha256(artifact) === patch.artifact_sha256, `${patch.id}: artifact checksum mismatch`)
    expect(patchId(artifact) === patch.patch_id_stable, `${patch.id}: artifact stable patch ID mismatch`)
    const header = artifact.toString('utf8', 0, 96).match(/^From ([0-9a-f]{40}) /)
    expect(header?.[1] === patch.source_commit, `${patch.id}: artifact source commit header mismatch`)

    ids.add(patch.id)
    artifacts.add(patch.artifact)
    previousOrder = patch.order
    previousCommit = patch.source_commit
  }

  const last = manifest.patches.at(-1)
  expect(manifest.source.tip === last.source_commit, 'source tip must equal final patch commit')
  expect(manifest.source.resulting_tree === last.source_tree, 'resulting tree must equal final patch tree')

  const diskArtifacts = fs.readdirSync(path.join(workflowRoot, 'patches'))
    .filter(name => name.endsWith('.patch'))
    .map(name => `patches/${name}`)
    .sort()
  const declaredArtifacts = [...artifacts].sort()
  expect(JSON.stringify(diskArtifacts) === JSON.stringify(declaredArtifacts), 'patch directory and manifest artifact set differ')

  if (source) verifySource(manifest, source)
  return manifest
}
