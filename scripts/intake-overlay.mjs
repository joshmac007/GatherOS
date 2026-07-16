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
  let resume = false
  let reviseLast = false
  for (let index = 0; index < argv.length;) {
    const flag = argv[index]
    if (flag === '--resume') {
      resume = true
      index += 1
      continue
    }
    if (flag === '--revise-last') {
      reviseLast = true
      index += 1
      continue
    }
    const value = argv[index + 1]
    if (!value || !['--source', '--spec'].includes(flag)) {
      fail('usage: intake-overlay.mjs [--resume | --revise-last] --source PATH --spec RELATIVE_PATH')
    }
    if (flag === '--source') source = path.resolve(value)
    if (flag === '--spec') spec = path.resolve(root, value)
    index += 2
  }
  if (resume && reviseLast) fail('--resume and --revise-last are mutually exclusive')
  if (!source || !spec) fail('both --source and --spec are required')
  return { source: fs.realpathSync(source), spec: fs.realpathSync(spec), resume, reviseLast }
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

function exactEqual(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected)
}

export function buildRevisionProposal(manifest, spec, source) {
  if (spec.schema_version !== 1) fail('intake spec schema_version must be 1')
  if (spec.expected_tip !== manifest.source.tip) fail('intake spec expected_tip is stale')
  if (!Array.isArray(spec.patches) || spec.patches.length !== 1) {
    fail('revision spec must contain exactly one patch')
  }
  if (typeof spec.workflow_commit_subject !== 'string' || !spec.workflow_commit_subject) {
    fail('workflow commit subject required')
  }

  const current = manifest.patches.at(-1)
  const declared = spec.patches[0]
  if (!current) fail('revision requires an existing final patch')
  if (declared.id !== current.id) fail('revision may replace only the final patch id')
  if (declared.revision !== current.revision + 1) {
    fail('revision must increment final patch revision by exactly one')
  }
  if (declared.class !== current.class) fail(`${current.id}: revision class mismatch`)
  if (declared.subject !== current.subject) fail(`${current.id}: revision subject mismatch`)
  if (!exactEqual(declared.logical_dependencies, current.logical_dependencies)) {
    fail(`${current.id}: revision logical dependencies mismatch`)
  }
  if (!exactEqual(declared.checks, current.checks)) fail(`${current.id}: revision checks mismatch`)
  if (!SHA.test(declared.source_commit || '')) fail(`${current.id}: source_commit must be a full SHA`)
  if (declared.source_commit === current.source_commit) fail(`${current.id}: revision source_commit is unchanged`)

  const oldCommit = git(
    ['rev-parse', '--verify', `${current.source_commit}^{commit}`],
    source,
    { allowFailure: true },
  )
  if (oldCommit.status !== 0 || oldCommit.stdout.trim() !== current.source_commit) {
    fail('overlay source does not contain current final patch evidence')
  }
  if (gitText(['rev-parse', 'HEAD'], source) !== declared.source_commit) {
    fail('overlay source HEAD must equal revised source_commit; extra commits are forbidden')
  }

  const parent = gitText(['rev-parse', `${declared.source_commit}^`], source)
  if (parent !== current.source_parent) {
    fail(`${current.id}: revised source parent must equal original source parent`)
  }
  const subject = gitText(['log', '-1', '--format=%s', declared.source_commit], source)
  if (subject !== current.subject) fail(`${current.id}: source subject mismatch`)

  const diff = git(['show', '--format=', '--full-index', '--binary', declared.source_commit], source).stdout
  const artifact = git(['format-patch', '-1', '--stdout', '--full-index', '--binary', declared.source_commit], source).stdout
  const entry = {
    ...current,
    revision: declared.revision,
    source_commit: declared.source_commit,
    source_parent: parent,
    source_tree: gitText(['rev-parse', `${declared.source_commit}^{tree}`], source),
    patch_id_stable: patchId(diff),
    canonical_diff_sha256: sha256(diff),
    artifact_sha256: sha256(artifact),
  }
  const next = structuredClone(manifest)
  next.patches[next.patches.length - 1] = entry
  next.source.tip = entry.source_commit
  next.source.resulting_tree = entry.source_tree
  return {
    manifest: next,
    artifacts: [{ relative: current.artifact, bytes: artifact }],
    subject: spec.workflow_commit_subject,
  }
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

function advanceEvidence(manifest, oldTip, source) {
  const pending = gitText([
    'for-each-ref', '--format=%(refname) %(objectname)', 'refs/gatherlocal/incoming-overlay',
  ], store).split('\n').filter(Boolean)
  if (pending.length > 1) fail('multiple unfinished overlay intake refs require diagnosis')
  let id
  let incoming
  if (pending.length === 1) {
    const [ref, tip] = pending[0].split(' ')
    if (tip !== manifest.source.tip) fail('unfinished overlay intake points at a different tip')
    incoming = ref
    id = path.basename(ref)
  } else {
    id = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
    incoming = `refs/gatherlocal/incoming-overlay/${id}`
    git(['fetch', '--no-tags', '--no-write-fetch-head', source, `${manifest.source.tip}:${incoming}`], store)
  }
  const recovery = `refs/gatherlocal/evidence-recovery/${id}`
  const transaction = [
    'start',
    `create ${recovery} ${oldTip}`,
    `update ${REF} ${manifest.source.tip} ${oldTip}`,
    `delete ${incoming} ${manifest.source.tip}`,
    'prepare',
    'commit',
    '',
  ].join('\n')
  git(['update-ref', '--stdin'], store, { input: Buffer.from(transaction) })
  loadAndVerifyManifest({ root, source: store })
  if (gitText(['status', '--porcelain'], root) !== '') fail('workflow repository dirty after intake')
  return { id, recovery, tip: manifest.source.tip }
}

function publishProposal(proposal, oldTip, source) {
  for (const artifact of proposal.artifacts) {
    fs.writeFileSync(path.join(root, artifact.relative), artifact.bytes, { flag: 'wx' })
  }
  fs.writeFileSync(manifestFile, `${JSON.stringify(proposal.manifest, null, 2)}\n`)
  const generated = ['manifests/overlay.v1.json', ...proposal.artifacts.map(item => item.relative)]
  git(['add', '--', ...generated], root)
  git(['diff', '--check', '--cached', '--', '.', ':(exclude)patches/*.patch'], root)
  git(['commit', '-m', proposal.subject, '--', ...generated], root)
  return advanceEvidence(proposal.manifest, oldTip, source)
}

function replaceFileAtomically(file, bytes) {
  const temporary = `${file}.intake-${process.pid}-${crypto.randomBytes(8).toString('hex')}`
  fs.writeFileSync(temporary, bytes, { flag: 'wx' })
  try {
    fs.renameSync(temporary, file)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

function publishRevisionProposal(proposal, oldTip, source) {
  const artifact = proposal.artifacts[0]
  const artifactFile = path.join(root, artifact.relative)
  const oldArtifact = fs.readFileSync(artifactFile)
  const oldManifest = fs.readFileSync(manifestFile)
  const newManifest = Buffer.from(`${JSON.stringify(proposal.manifest, null, 2)}\n`)
  const generated = ['manifests/overlay.v1.json', artifact.relative]
  let committed = false
  try {
    replaceFileAtomically(artifactFile, artifact.bytes)
    replaceFileAtomically(manifestFile, newManifest)
    git(['add', '--', ...generated], root)
    git(['diff', '--check', '--cached', '--', '.', ':(exclude)patches/*.patch'], root)
    git(['commit', '-m', proposal.subject, '--', ...generated], root)
    committed = true
  } finally {
    if (!committed) {
      replaceFileAtomically(artifactFile, oldArtifact)
      replaceFileAtomically(manifestFile, oldManifest)
      git(['add', '--', ...generated], root)
    }
  }
  return advanceEvidence(proposal.manifest, oldTip, source)
}

function main() {
try {
  const options = parseArgs(process.argv.slice(2))
  assertRepositoryBoundaries(options.source)
  const spec = JSON.parse(fs.readFileSync(options.spec, 'utf8'))
  if (options.resume) {
    const manifest = loadAndVerifyManifest({ root })
    if (spec.expected_tip === manifest.source.tip) fail('resume requires an already-committed manifest extension')
    const proposal = { manifest, artifacts: [], subject: spec.workflow_commit_subject }
    verifyProposal(proposal, options.source)
    const result = advanceEvidence(manifest, spec.expected_tip, options.source)
    console.log(`PASS: overlay intake ${result.tip}`)
    console.log(`Recovery ref: ${result.recovery}`)
    process.exit(0)
  }
  const manifest = loadAndVerifyManifest({ root, source: store })
  const proposal = options.reviseLast
    ? buildRevisionProposal(manifest, spec, options.source)
    : buildProposal(manifest, spec, options.source)
  verifyProposal(proposal, options.source)
  const result = options.reviseLast
    ? publishRevisionProposal(proposal, manifest.source.tip, options.source)
    : publishProposal(proposal, manifest.source.tip, options.source)
  console.log(`PASS: overlay intake ${result.tip}`)
  console.log(`Recovery ref: ${result.recovery}`)
} catch (error) {
  console.error(`FAIL: ${error.message}`)
  process.exit(1)
}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
