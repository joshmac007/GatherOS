import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  assertEqual,
  regularFileInside,
  sha256File,
  treeInventory,
} from './data-rehearsal.mjs'

function fail(message) {
  throw new Error(message)
}

function commandVersion(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: 'utf8',
    timeout: 30_000,
  })
  if (result.error || result.status !== 0) {
    fail(`${command} version probe failed`)
  }
  return result.stdout.trim()
}

export function loadDependencyContract(file) {
  const contract = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (contract.schema_version !== 1
    || contract.contract_id !== 'gatherlocal-root-node-modules-20260714') {
    fail('unsupported dependency contract')
  }
  if (contract.platform !== 'darwin' || contract.arch !== 'arm64') {
    fail('dependency contract must target macOS arm64')
  }
  if (JSON.stringify(contract.node_modules?.ignored_names) !== JSON.stringify(['.DS_Store'])) {
    fail('dependency contract may ignore only Finder metadata')
  }
  return contract
}

function dependencyTreeInventory(modules, contract) {
  const ignored = new Set(contract.node_modules.ignored_names)
  return treeInventory(modules, {
    includeContent: true,
    exclude: relative => ignored.has(path.basename(relative)),
  })
}

export function verifyDependencySnapshot(appRoot, contract, { verifyTools = true, env = process.env } = {}) {
  const physicalRoot = fs.realpathSync(appRoot)
  const modules = path.join(physicalRoot, 'node_modules')
  const modulesStat = fs.lstatSync(modules)
  if (modulesStat.isSymbolicLink() || !modulesStat.isDirectory()) {
    fail('node_modules must be a physical directory')
  }
  if (fs.realpathSync(path.dirname(modules)) !== physicalRoot) {
    fail('node_modules escapes app root')
  }

  assertEqual(sha256File(regularFileInside(physicalRoot, 'package.json', 'package manifest')),
    contract.package_json_sha256, 'package manifest')
  assertEqual(
    sha256File(regularFileInside(physicalRoot, contract.node_modules.install_lock_relative, 'installed dependency lock')),
    contract.node_modules.install_lock_sha256,
    'installed dependency lock',
  )
  for (const [relative, expected] of Object.entries(contract.node_modules.key_files)) {
    assertEqual(sha256File(regularFileInside(physicalRoot, relative, 'dependency key file')),
      expected, `dependency key file ${relative}`)
  }
  const inventory = dependencyTreeInventory(modules, contract)
  assertEqual(inventory, {
    count: contract.node_modules.entry_count,
    sha256: contract.node_modules.tree_sha256,
  }, 'node_modules tree')

  const versions = {
    node: process.version,
    electron: commandVersion(path.join(modules, '.bin/electron'), ['--version'], { cwd: physicalRoot, env }),
    electron_node: commandVersion(path.join(modules, '.bin/electron'), ['-p', 'process.version'], {
      cwd: physicalRoot,
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    }),
    npm: commandVersion('npm', ['--version'], { cwd: physicalRoot, env }),
  }
  if (verifyTools) {
    assertEqual(process.platform, contract.platform, 'dependency platform')
    assertEqual(process.arch, contract.arch, 'dependency architecture')
    assertEqual(versions, contract.tools, 'dependency tool versions')
  }

  return {
    package_json_sha256: contract.package_json_sha256,
    install_lock_sha256: contract.node_modules.install_lock_sha256,
    tree: inventory,
    tools: versions,
  }
}

export function cloneDependencySnapshot(sourceRoot, candidateRoot, contract, {
  verifyCandidatePackage = true,
  env = process.env,
} = {}) {
  const source = fs.realpathSync(sourceRoot)
  const candidate = fs.realpathSync(candidateRoot)
  if (fs.existsSync(path.join(candidate, 'node_modules'))) {
    fail('candidate node_modules already exists')
  }
  if (verifyCandidatePackage) {
    assertEqual(sha256File(regularFileInside(candidate, 'package.json', 'candidate package manifest')),
      contract.package_json_sha256, 'candidate package manifest')
  }
  const copy = spawnSync('/bin/cp', ['-cR', path.join(source, 'node_modules'), path.join(candidate, 'node_modules')], {
    encoding: 'utf8',
    timeout: 5 * 60_000,
  })
  if (copy.error || copy.status !== 0) fail(`dependency clone failed: ${(copy.stderr || '').trim()}`)
  return verifyCandidatePackage
    ? verifyDependencySnapshot(candidate, contract, { env })
    : { tree: dependencyTreeInventory(path.join(candidate, 'node_modules'), contract) }
}
