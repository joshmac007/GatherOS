#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadAndVerifyManifest } from '../lib/manifest.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let upstream
let source
let keep = false

for (let index = 2; index < process.argv.length; index += 1) {
  const flag = process.argv[index]
  if (flag === '--keep') {
    keep = true
    continue
  }
  const value = process.argv[index + 1]
  if (!['--upstream', '--source'].includes(flag) || !value) {
    console.error(`Usage: ${process.argv[1]} --upstream PATH [--source PATH] [--keep]`)
    process.exit(2)
  }
  if (flag === '--upstream') upstream = path.resolve(value)
  if (flag === '--source') source = path.resolve(value)
  index += 1
}

if (!upstream) {
  console.error('--upstream is required')
  process.exit(2)
}

function run(args, cwd) {
  const result = spawnSync(args[0], args.slice(1), {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error(`${args.join(' ')} failed\n${result.stderr.trim()}`)
  }
  return result.stdout.trim()
}

const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherlocal-manifest-replay.'))
const candidate = path.join(runRoot, 'candidate')
let passed = false

try {
  const manifest = loadAndVerifyManifest({ root, source })
  if (run(['git', 'status', '--porcelain'], upstream) !== '') {
    throw new Error('upstream source clone must be clean')
  }
  if (run(['git', 'rev-parse', `${manifest.upstream.tested_base}^{commit}`], upstream) !== manifest.upstream.tested_base) {
    throw new Error('tested base is missing from upstream clone')
  }

  run(['git', 'clone', '--no-hardlinks', '--no-checkout', upstream, candidate], root)
  run(['git', 'checkout', '--detach', manifest.upstream.tested_base], candidate)
  run(['git', 'config', 'user.name', 'GatherLocal replay probe'], candidate)
  run(['git', 'config', 'user.email', 'gatherlocal-replay@invalid.local'], candidate)

  for (const patch of manifest.patches) {
    run(['git', 'am', '--3way', path.join(root, patch.artifact)], candidate)
    const tree = run(['git', 'rev-parse', 'HEAD^{tree}'], candidate)
    if (tree !== patch.source_tree) throw new Error(`${patch.id}: replay tree mismatch`)
    console.log(`PASS: replayed ${patch.id} -> ${tree}`)
  }

  const finalTree = run(['git', 'rev-parse', 'HEAD^{tree}'], candidate)
  if (finalTree !== manifest.source.resulting_tree) throw new Error('final replay tree mismatch')
  if (run(['git', 'rev-list', '--count', `${manifest.upstream.tested_base}..HEAD`], candidate) !== String(manifest.patches.length)) {
    throw new Error('replay commit count mismatch')
  }
  if (run(['git', 'status', '--porcelain'], candidate) !== '') throw new Error('replay candidate is dirty')
  run(['git', 'diff', '--check', manifest.upstream.tested_base, 'HEAD'], candidate)
  run(['git', 'fsck', '--full'], candidate)

  passed = true
  console.log(`PASS: disposable replay produced ${finalTree}`)
  if (keep) console.log(`Candidate preserved: ${candidate}`)
} catch (error) {
  console.error(`FAIL: ${error.message}`)
  console.error(`Failed candidate preserved: ${candidate}`)
  process.exitCode = 1
} finally {
  if (passed && !keep) fs.rmSync(runRoot, { recursive: true, force: true })
}

