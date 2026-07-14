#!/usr/bin/env node

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadAndVerifyManifest } from '../lib/manifest.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
let root = path.resolve(scriptDir, '..')
let manifestPath = 'manifests/overlay.v1.json'
let source

for (let index = 2; index < process.argv.length; index += 1) {
  const flag = process.argv[index]
  const value = process.argv[index + 1]
  if (!['--root', '--manifest', '--source'].includes(flag) || !value) {
    console.error(`Usage: ${process.argv[1]} [--root PATH] [--manifest RELATIVE_PATH] [--source PATH]`)
    process.exit(2)
  }
  if (flag === '--root') root = path.resolve(value)
  if (flag === '--manifest') manifestPath = value
  if (flag === '--source') source = path.resolve(value)
  index += 1
}

try {
  const manifest = loadAndVerifyManifest({ root, manifestPath, source })
  console.log(`PASS: ${manifest.stack_id} manifest (${manifest.patches.length} patches)`)
} catch (error) {
  console.error(`FAIL: ${error.message}`)
  process.exit(1)
}

