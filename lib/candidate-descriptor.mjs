import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { assertEqual, sha256File } from './data-rehearsal.mjs'

const SHA1 = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/

function fail(message) {
  throw new Error(message)
}

function git(args, cwd, { input, allowFailure = false, env = process.env } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    input,
    encoding: input === undefined ? 'utf8' : undefined,
    maxBuffer: 64 * 1024 * 1024,
    env,
  })
  if (!allowFailure && (result.error || result.status !== 0)) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : result.stderr || ''
    fail(`git ${args.join(' ')} failed: ${stderr.trim()}`)
  }
  return result
}

function gitText(args, cwd, env) {
  return git(args, cwd, { env }).stdout.trim()
}

function stablePatchId(commit, cwd, env) {
  const diff = git(['show', '--format=', '--full-index', '--binary', commit], cwd, { env }).stdout
  const output = git(['patch-id', '--stable'], cwd, { input: diff, env }).stdout.toString('utf8').trim()
  const id = output.split(/\s+/)[0]
  if (!SHA1.test(id)) fail(`candidate commit ${commit} has no stable patch ID`)
  return id
}

export function manifestIdentity(workflowRoot, manifest) {
  const manifestPath = path.join(workflowRoot, 'manifests/overlay.v1.json')
  return {
    sha256: sha256File(manifestPath),
    stack_id: manifest.stack_id,
    patches: manifest.patches.map(patch => ({
      id: patch.id,
      revision: patch.revision,
      artifact_sha256: patch.artifact_sha256,
      patch_id_stable: patch.patch_id_stable,
    })),
  }
}

export function createCandidateDescriptor({
  runId,
  workflowRoot,
  manifest,
  previousTarget,
  target,
  tip,
  tree,
  replay,
}) {
  if (!runId || !SHA1.test(previousTarget) || !SHA1.test(target)
    || !SHA1.test(tip) || !SHA1.test(tree)) {
    fail('candidate descriptor inputs are invalid')
  }
  return {
    schema_version: 1,
    descriptor_id: 'gatherlocal-sync-candidate',
    run_id: runId,
    upstream: {
      previous_target: previousTarget,
      target,
    },
    candidate: {
      branch: manifest.source.branch,
      tip,
      tree,
    },
    manifest: manifestIdentity(workflowRoot, manifest),
    replay,
  }
}

export function verifyCandidateDescriptor({ file, workflowRoot, appSource, manifest, env = process.env }) {
  const lexicalStat = fs.lstatSync(file)
  if (lexicalStat.isSymbolicLink() || !lexicalStat.isFile()) fail('candidate descriptor must be a regular file')
  const descriptorPath = fs.realpathSync(file)
  const stat = fs.lstatSync(descriptorPath)
  if (stat.isSymbolicLink() || !stat.isFile()) fail('candidate descriptor must be a regular file')
  const descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'))
  if (descriptor.schema_version !== 1
    || descriptor.descriptor_id !== 'gatherlocal-sync-candidate') {
    fail('unsupported candidate descriptor')
  }
  if (!SHA1.test(descriptor.upstream?.previous_target || '')
    || !SHA1.test(descriptor.upstream?.target || '')
    || !SHA1.test(descriptor.candidate?.tip || '')
    || !SHA1.test(descriptor.candidate?.tree || '')
    || !SHA256.test(descriptor.manifest?.sha256 || '')) {
    fail('candidate descriptor contains invalid Git or manifest identities')
  }
  assertEqual(descriptor.manifest, manifestIdentity(workflowRoot, manifest), 'candidate manifest identity')

  const source = fs.realpathSync(appSource)
  assertEqual(gitText(['status', '--porcelain'], source, env), '', 'candidate source status')
  assertEqual(gitText(['rev-parse', 'HEAD'], source, env), descriptor.candidate.tip, 'candidate tip')
  assertEqual(gitText(['rev-parse', 'HEAD^{tree}'], source, env), descriptor.candidate.tree, 'candidate tree')
  assertEqual(gitText(['symbolic-ref', '--short', 'HEAD'], source, env), descriptor.candidate.branch, 'candidate branch')
  assertEqual(
    gitText(['rev-parse', manifest.source.canonical_evidence_ref], source, env),
    manifest.source.tip,
    'candidate canonical evidence ref',
  )
  assertEqual(
    gitText(['rev-parse', `${descriptor.upstream.target}^{commit}`], source, env),
    descriptor.upstream.target,
    'candidate target object',
  )
  for (const ancestor of [manifest.upstream.release_floor, manifest.upstream.tested_base, descriptor.upstream.previous_target]) {
    const ancestry = git(['merge-base', '--is-ancestor', ancestor, descriptor.upstream.target], source, { allowFailure: true, env })
    if (ancestry.status !== 0) fail(`candidate target does not descend from ${ancestor}`)
  }
  const targetToTip = git(['merge-base', '--is-ancestor', descriptor.upstream.target, descriptor.candidate.tip], source, { allowFailure: true, env })
  if (targetToTip.status !== 0) fail('candidate tip does not descend from target')

  const commits = gitText(['rev-list', '--reverse', `${descriptor.upstream.target}..${descriptor.candidate.tip}`], source, env)
    .split('\n').filter(Boolean)
  if (!Array.isArray(descriptor.replay) || descriptor.replay.length !== manifest.patches.length) {
    fail('candidate replay length mismatch')
  }
  assertEqual(commits, descriptor.replay.map(item => item.commit), 'candidate replay commits')
  for (let index = 0; index < manifest.patches.length; index += 1) {
    const patch = manifest.patches[index]
    const replay = descriptor.replay[index]
    assertEqual(replay.id, patch.id, `${patch.id} replay ID`)
    assertEqual(replay.stable_patch_id, patch.patch_id_stable, `${patch.id} descriptor patch ID`)
    assertEqual(gitText(['rev-parse', `${replay.commit}^{tree}`], source, env), replay.tree, `${patch.id} replay tree`)
    assertEqual(gitText(['log', '-1', '--format=%s', replay.commit], source, env), patch.subject, `${patch.id} replay subject`)
    assertEqual(stablePatchId(replay.commit, source, env), patch.patch_id_stable, `${patch.id} replay patch ID`)
  }

  return {
    descriptor,
    descriptor_sha256: sha256File(descriptorPath),
  }
}
