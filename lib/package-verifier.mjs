import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { verifyCandidateDescriptor } from './candidate-descriptor.mjs'
import { sha256File } from './data-rehearsal.mjs'

function fail(message) {
  throw new Error(message)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout || 60_000,
  })
  if (result.error || result.status !== 0) {
    fail(`${command} ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`)
  }
  return result.stdout.trim()
}

function physicalInside(root, relative, type) {
  const lexical = path.resolve(root, relative)
  const stat = fs.lstatSync(lexical)
  if (stat.isSymbolicLink() || (type === 'file' ? !stat.isFile() : !stat.isDirectory())) {
    fail(`${relative} is not a physical ${type}`)
  }
  const physical = fs.realpathSync(lexical)
  const owner = fs.realpathSync(root)
  const rel = path.relative(owner, physical)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) fail(`${relative} escapes candidate source`)
  return physical
}

export function verifyPackagedApp({ workflowRoot, appSource, descriptorFile, manifest, env = process.env }) {
  const source = fs.realpathSync(appSource)
  const descriptor = verifyCandidateDescriptor({
    file: descriptorFile,
    workflowRoot,
    appSource: source,
    manifest,
    env,
  })
  const appBundle = physicalInside(source, 'dist/build/mac-arm64/GatherLocal.app', 'directory')
  const resources = physicalInside(appBundle, 'Contents/Resources', 'directory')
  const asarPath = physicalInside(resources, 'app.asar', 'file')
  const unpacked = physicalInside(resources, 'app.asar.unpacked', 'directory')
  const binary = physicalInside(appBundle, 'Contents/MacOS/GatherLocal', 'file')

  const appRequire = createRequire(path.join(source, 'package.json'))
  const asar = appRequire('@electron/asar')
  const entries = new Set(asar.listPackage(asarPath))
  const required = [
    '/package.json',
    '/src/main/index.js',
    '/src/main/db.js',
    '/src/main/persistent-state.js',
    '/src/shared/runtime-identity.js',
    '/dist/renderer/index.html',
  ]
  for (const entry of required) {
    if (!entries.has(entry)) fail(`packaged app is missing ${entry}`)
  }
  const packaged = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'))
  if (packaged.name !== 'gatherlocal' || packaged.productName !== 'GatherLocal'
    || packaged.main !== 'src/main/index.js' || !/^0\.7\.0-local\./.test(packaged.version)) {
    fail('packaged GatherLocal identity is invalid')
  }

  for (const relative of [
    'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
    'node_modules/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64.node',
  ]) {
    physicalInside(unpacked, relative, 'file')
  }
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appBundle])
  run(path.join(source, 'node_modules/.bin/electron'), [
    '-e',
    `require(${JSON.stringify(path.join(asarPath, 'src/main/persistent-state.js'))}); process.stdout.write('loaded')`,
  ], {
    cwd: source,
    env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
  })

  return {
    descriptor_sha256: descriptor.descriptor_sha256,
    app_bundle: 'dist/build/mac-arm64/GatherLocal.app',
    binary_sha256: sha256File(binary),
    asar_sha256: sha256File(asarPath),
    asar_entry_count: entries.size,
    required_entries: required,
    identity: {
      name: packaged.name,
      product_name: packaged.productName,
      version: packaged.version,
      main: packaged.main,
    },
    codesign: 'verified',
    packaged_module_load: 'persistent-state loaded',
  }
}
