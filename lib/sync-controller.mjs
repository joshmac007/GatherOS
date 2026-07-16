import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const SHA1 = /^[0-9a-f]{40}$/

export function fail(message) {
  throw new Error(message)
}

export function assertSha(value, label) {
  if (!SHA1.test(value || '')) fail(`${label} must be a full commit SHA`)
  return value
}

export function safeEnvironment(root, extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: path.join(root, 'home'),
    TMPDIR: path.join(root, 'tmp'),
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
    GIT_SSH_COMMAND: '/usr/bin/false',
    ...extra,
  }
}

export function run(command, args, {
  cwd,
  env = process.env,
  input,
  allowFailure = false,
  timeout = 10 * 60_000,
  logFile,
} = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    input,
    encoding: input === undefined ? 'utf8' : undefined,
    maxBuffer: 128 * 1024 * 1024,
    timeout,
  })
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout.toString('utf8') : result.stdout || ''
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : result.stderr || ''
  if (logFile) {
    fs.appendFileSync(logFile, [
      `$ ${command} ${args.join(' ')}`,
      stdout,
      stderr,
      `exit=${result.status ?? 'error'}`,
      '',
    ].join('\n'))
  }
  if (!allowFailure && (result.error || result.status !== 0)) {
    fail(`${command} ${args.join(' ')} failed: ${(stderr || stdout || result.error?.message || '').trim()}`)
  }
  return { ...result, stdout, stderr }
}

export function git(args, cwd, options = {}) {
  return run('git', args, { cwd, ...options })
}

export function gitText(args, cwd, options = {}) {
  return git(args, cwd, options).stdout.trim()
}

export function writeNewFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}`
  fs.writeFileSync(temporary, content, { flag: 'wx' })
  try {
    fs.linkSync(temporary, file)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

export function writeNewJson(file, value) {
  writeNewFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

export function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
  fs.renameSync(temporary, file)
}

export function sha256File(file) {
  const digest = crypto.createHash('sha256')
  const descriptor = fs.openSync(file, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    for (;;) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null)
      if (count === 0) break
      digest.update(buffer.subarray(0, count))
    }
  } finally {
    fs.closeSync(descriptor)
  }
  return digest.digest('hex')
}

export function acquireLock(lockPath, runId) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  try {
    fs.mkdirSync(lockPath)
  } catch (error) {
    if (error.code === 'EEXIST') fail(`sync lock already exists: ${lockPath}`)
    throw error
  }
  fs.writeFileSync(path.join(lockPath, 'owner.json'), `${JSON.stringify({
    schema_version: 1,
    run_id: runId,
    pid: process.pid,
    started_at: new Date().toISOString(),
  }, null, 2)}\n`, { flag: 'wx' })
}

export function releaseLock(lockPath, runId) {
  const owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'))
  if (owner.run_id !== runId || owner.pid !== process.pid) fail('sync lock ownership changed')
  fs.rmSync(lockPath, { recursive: true })
}

export function atomicPointSymlink(linkPath, targetPath) {
  const parent = fs.realpathSync(path.dirname(linkPath))
  const target = fs.realpathSync(targetPath)
  if (path.dirname(target) !== fs.realpathSync(path.join(parent, 'GatherLocal-Reconstructions'))) {
    fail('accepted pointer target is outside reconstruction store')
  }
  const temporary = path.join(parent, `.GatherLocal-Next.${process.pid}.tmp`)
  if (fs.existsSync(temporary) || fs.lstatSync(linkPath).isSymbolicLink() === false) {
    fail('accepted pointer cannot be replaced safely')
  }
  fs.symlinkSync(path.relative(parent, target), temporary, 'dir')
  fs.renameSync(temporary, linkPath)
  if (fs.realpathSync(linkPath) !== target) fail('accepted pointer verification failed')
}

export function promoteRefs({ store, runId, oldTip, newTip, previousTarget, target, canonicalTip, env, logFile }) {
  for (const [value, label] of [
    [oldTip, 'old accepted tip'],
    [newTip, 'new accepted tip'],
    [previousTarget, 'previous upstream target'],
    [target, 'new upstream target'],
    [canonicalTip, 'canonical evidence tip'],
  ]) assertSha(value, label)
  if (!/^[0-9]{8}T[0-9]{6}Z-[a-z0-9]{8}$/.test(runId)) fail('invalid promotion run ID')
  const transaction = [
    'start',
    `verify refs/gatherlocal/evidence/overlay-v1 ${canonicalTip}`,
    `create refs/gatherlocal/recovery/${runId} ${oldTip}`,
    `create refs/gatherlocal/upstream/recovery/${runId} ${previousTarget}`,
    `update refs/gatherlocal/accepted ${newTip} ${oldTip}`,
    `update refs/gatherlocal/upstream/accepted ${target} ${previousTarget}`,
    `delete refs/gatherlocal/incoming/${runId} ${newTip}`,
    'prepare',
    'commit',
    '',
  ].join('\n')
  git(['update-ref', '--stdin'], store, { input: transaction, env, logFile })
}

export function parseSyncArguments(argv) {
  const [command, ...rest] = argv
  if (!['init', 'sync', 'rebuild'].includes(command)) fail('command must be init, sync, or rebuild')
  if (command === 'init' || command === 'rebuild') {
    if (rest.length !== 0) fail(`${command} accepts no options`)
    return { command }
  }
  let upstreamRef
  let targetSha = null
  const seen = new Set()
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index]
    const value = rest[index + 1]
    if (!['--upstream-ref', '--target-sha'].includes(flag) || !value) fail('invalid sync options')
    if (seen.has(flag)) fail(`duplicate sync option: ${flag}`)
    seen.add(flag)
    if (flag === '--upstream-ref') upstreamRef = value
    if (flag === '--target-sha') targetSha = assertSha(value, 'target SHA')
  }
  if (upstreamRef !== 'upstream/main') fail('upstream ref must be exactly upstream/main')
  return { command, upstreamRef, targetSha }
}
