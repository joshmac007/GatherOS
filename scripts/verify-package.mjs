#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadAndVerifyManifest } from '../lib/manifest.mjs'
import { verifyPackagedApp } from '../lib/package-verifier.mjs'

const workflowRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let appSource
let descriptorFile
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index]
  const value = process.argv[index + 1]
  if (!['--app-source', '--candidate-descriptor'].includes(flag) || !value) {
    console.error(`Usage: ${process.argv[1]} --app-source PATH --candidate-descriptor PATH`)
    process.exit(2)
  }
  if (flag === '--app-source') appSource = path.resolve(value)
  if (flag === '--candidate-descriptor') descriptorFile = path.resolve(value)
}
if (!appSource || !descriptorFile) {
  console.error('--app-source and --candidate-descriptor are required')
  process.exit(2)
}

try {
  const manifest = loadAndVerifyManifest({ root: workflowRoot, source: appSource })
  const receipt = verifyPackagedApp({ workflowRoot, appSource, descriptorFile, manifest })
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
} catch (error) {
  console.error(`FAIL: ${error.message}`)
  process.exitCode = 1
}
