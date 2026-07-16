#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadAndVerifyManifest } from '../lib/manifest.mjs'

const root = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'))
const workspace = fs.realpathSync(path.resolve(root, '..'))
const store = path.join(workspace, 'GatherLocal-Accepted.git')
const manifestFile = path.join(root, 'manifests/overlay.v1.json')
const REF = 'refs/gatherlocal/evidence/overlay-v1'
const SHA = /^[0-9a-f]{40}$/

function fail(message) { throw new Error(message) }

function run(command, args, { cwd = root, input, allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    input,
    encoding: input === undefined ? 'utf8' : undefined,
    maxBuffer: 128 * 1024 * 1024,
  })
  if (!allowFailure && (result.error || result.status !== 0)) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : result.stderr || ''
    const stdout = Buffer.isBuffer(result.stdout) ? result.stdout.toString('utf8') : result.stdout || ''
    fail(`${command} ${args.join(' ')} failed: ${(stderr || stdout || result.error?.message || '').trim()}`)
  }
  return result
}

function git(args, cwd = root, options = {}) { return run('git', args, { cwd, ...options }) }
function gitText(args, cwd = root) { return git(args, cwd).stdout.trim() }
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex') }

function patchId(bytes) {
  const output = git(['patch-id', '--stable'], root, { input: bytes }).stdout.toString('utf8').trim()
  const id = output.split(/\s+/)[0]
  if (!SHA.test(id)) fail('patch did not produce a stable patch ID')
  return id
}

function parseArgs(argv) {
  let source
  let spec
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!value || !['--source', '--spec'].includes(flag)) fail('usage: intake-overlay.mjs --source PATH --spec RELATIVE_PATH')
    if (flag === '--source') source = path.resolve(value)
    if (flag === '--spec') spec = path.resolve(root, value)
  }
  if (!source || !spec) fail('both --source and --spec are required')
  return { source: fs.realpathSync(source), spec: fs.realpathSync(spec) }
}

function assertRepositoryBoundaries(source) {
  if (gitText(['status', '--porcelain'], root) !== '') fail('workflow repository must be clean')
  if (gitText(['status', '--porcelain'], source) !== '') fail('overlay source must be clean')
  if (gitText(['rev-parse', '--is-bare-repository'], store) !== 'true') fail('acceptance store must be bare')
  if (gitText(['remote'], store) !== '') fail('acceptance store must have no remotes')
  if (gitText(['config', '--local', '--get', 'push.default'], store) !== 'nothing') fail('acceptance store push.default must be nothing')
  if (gitText(['config', '--local', '--get', 'push.default'], source) !== 'nothing') fail('overlay source push.default must be nothing')
  const remotes = gitText(['remote'], source).split('\n').filter(Boolean)
  for (const remote of remotes) {
    if (gitText(['remote', 'get-url', '--push', remote], source) !== 'DISABLED') {
      fail(`overlay source remote ${remote} can push`)
    }
  }
}

function buildProposal(manifest, spec, source) {
  if (spec.schema_version !== 1) fail('intake spec schema_version must be 1')
  if (spec.expected_tip !== manifest.source.tip) fail('intake spec expected_tip is stale')
  if (!Array.isArray(spec.patches) || spec.patches.length === 0) fail('intake spec requires patches')
  if (typeof spec.workflow_commit_subject !== 'string' || !spec.workflow_commit_subject) fail('workflow commit subject required')

  const next = structuredClone(manifest)
  let previous = manifest.source.tip
  let order = manifest.patches.at(-1).order
  const artifacts = []
  const ids = new Set(manifest.patches.map(patch => patch.id))

  for (const declared of spec.patches) {
    if (!SHA.test(declared.source_commit || '')) fail(`${declared.id || 'patch'} source_commit must be a full SHA`)
    if (ids.has(declared.id)) fail(`duplicate patch id: ${declared.id}`)
    const parent = gitText(['rev-parse', `${declared.source_commit}^`], source)
    if (parent !== previous) fail(`${declared.id}: source chain is not linear`)
    const subject = gitText(['log', '-1', '--format=%s', declared.source_commit], source)
    if (subject !== declared.subject) fail(`${declared.id}: source subject mismatch`)
    const diff = git(['show', '--format=', '--full-index', '--binary', declared.source_commit], source).stdout
    const artifact = git(['format-patch', '-1', '--stdout', '--full-index', '--binary', declared.source_commit], source).stdout
    order += 10
    const artifactPath = `patches/${String(order).padStart(4, '0')}-${declared.id}.patch`
    const entry = {
      order,
      id: declared.id,
      revision: declared.revision || 1,
      class: declared.class,
      ...(declared.class === 'pending-contribution' ? { contribution_state: 'pending-local-only' } : {}),
      subject,
      source_commit: declared.source_commit,
      source_parent: parent,
      source_tree: gitText(['rev-parse', `${declared.source_commit}^{tree}`], source),
      logical_dependencies: declared.logical_dependencies || [],
      patch_id_stable: patchId(diff),
      canonical_diff_sha256: sha256(diff),
      artifact: artifactPath,
      artifact_sha256: sha256(artifact),
      acceptance_policy: declared.class === 'pending-contribution'
        ? manifest.acceptance.pending_contribution_policy
        : manifest.acceptance.personal_policy,
      checks: declared.checks,
    }
    next.patches.push(entry)
    artifacts.push({ relative: artifactPath, bytes: artifact })
    ids.add(declared.id)
    previous = declared.source_commit
  }
  next.source.tip = previous
  next.source.resulting_tree = gitText(['rev-parse', `${previous}^{tree}`], source)
  return { manifest: next, artifacts, subject: spec.workflow_commit_subject }
}

function verifyProposal(proposal, source) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherlocal-overlay-intake.'))
  try {
    fs.mkdirSync(path.join(temporary, 'manifests'))
    fs.mkdirSync(path.join(temporary, 'patches'))
    for (const patch of proposal.manifest.patches) {
      const incoming = proposal.artifacts.find(item => item.relative === patch.artifact)
      const bytes = incoming?.bytes || fs.readFileSync(path.join(root, patch.artifact))
      fs.writeFileSync(path.join(temporary, patch.artifact), bytes)
    }
    fs.writeFileSync(path.join(temporary, 'manifests/overlay.v1.json'), `${JSON.stringify(proposal.manifest, null, 2)}\n`)
    const evidence = path.join(temporary, 'evidence.git')
    git(['clone', '--bare', '--no-hardlinks', source, evidence], temporary)
    git(['update-ref', REF, proposal.manifest.source.tip], evidence)
    loadAndVerifyManifest({ root: temporary, source: evidence })
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}

function publishProposal(proposal, source) {
  for (const artifact of proposal.artifacts) {
    fs.writeFileSync(path.join(root, artifact.relative), artifact.bytes, { flag: 'wx' })
  }
  fs.writeFileSync(manifestFile, `${JSON.stringify(proposal.manifest, null, 2)}\n`)
  const generated = ['manifests/overlay.v1.json', ...proposal.artifacts.map(item => item.relative)]
  git(['add', '--', ...generated], root)
  git(['diff', '--check', '--cached'], root)
  git(['commit', '-m', proposal.subject, '--', ...generated], root)

  const id = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  const incoming = `refs/gatherlocal/incoming-overlay/${id}`
  const recovery = `refs/gatherlocal/evidence-recovery/${id}`
  git(['fetch', '--no-tags', '--no-write-fetch-head', source, `${proposal.manifest.source.tip}:${incoming}`], store)
  const transaction = [
    'start',
    `verify ${REF} ${proposal.manifest.patches.at(-proposal.artifacts.length - 1).source_commit}`,
    `create ${recovery} ${proposal.manifest.patches.at(-proposal.artifacts.length - 1).source_commit}`,
    `update ${REF} ${proposal.manifest.source.tip} ${proposal.manifest.patches.at(-proposal.artifacts.length - 1).source_commit}`,
    `delete ${incoming} ${proposal.manifest.source.tip}`,
    'prepare',
    'commit',
    '',
  ].join('\n')
  git(['update-ref', '--stdin'], store, { input: Buffer.from(transaction) })
  loadAndVerifyManifest({ root, source: store })
  if (gitText(['status', '--porcelain'], root) !== '') fail('workflow repository dirty after intake')
  return { id, recovery, tip: proposal.manifest.source.tip }
}

try {
  const options = parseArgs(process.argv.slice(2))
  assertRepositoryBoundaries(options.source)
  const manifest = loadAndVerifyManifest({ root, source: store })
  const spec = JSON.parse(fs.readFileSync(options.spec, 'utf8'))
  const proposal = buildProposal(manifest, spec, options.source)
  verifyProposal(proposal, options.source)
  const result = publishProposal(proposal, options.source)
  console.log(`PASS: overlay intake ${result.tip}`)
  console.log(`Recovery ref: ${result.recovery}`)
} catch (error) {
  console.error(`FAIL: ${error.message}`)
  process.exit(1)
}
