import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

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

export function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

export function isInsideOrEqual(parent, child) {
  return path.resolve(parent) === path.resolve(child) || isInside(parent, child)
}

export function resolveInside(parent, relative, label = 'path') {
  if (typeof relative !== 'string' || relative.length === 0 || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a non-empty relative path`)
  }
  const resolved = path.resolve(parent, relative)
  if (!isInside(parent, resolved)) throw new Error(`${label} escapes its owner`)
  return resolved
}

export function regularFileInside(parent, relative, label = 'file') {
  const resolved = resolveInside(parent, relative, label)
  const stat = fs.lstatSync(resolved)
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular file, not a symlink`)
  }
  const physical = fs.realpathSync(resolved)
  if (!isInside(parent, physical)) throw new Error(`${label} escapes its physical owner`)
  return resolved
}

export function authorizeNewJsonPath(requested, { allowedRoots, forbiddenRoots = [] }) {
  if (path.extname(requested) !== '.json') throw new Error('receipt must be a new .json file')
  if (fs.existsSync(requested)) throw new Error('receipt already exists; refusing to overwrite it')
  const parent = fs.realpathSync(path.dirname(requested))
  const allowed = allowedRoots.map(root => fs.realpathSync(root))
  const forbidden = forbiddenRoots.map(root => fs.realpathSync(root))
  if (!allowed.some(root => isInsideOrEqual(root, parent))) {
    throw new Error('receipt parent is outside workflow-owned evidence roots')
  }
  if (forbidden.some(root => isInsideOrEqual(root, parent))) {
    throw new Error('receipt may not be written inside a protected source root')
  }
  return path.join(parent, path.basename(requested))
}

export function macSandboxProfile(runRoot) {
  return [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    '(deny file-write*)',
    `(allow file-write* (subpath ${JSON.stringify(fs.realpathSync(runRoot))}))`,
  ].join(' ')
}

export function treeInventory(root, { includeMtime = false, exclude = () => false } = {}) {
  const physicalRoot = fs.realpathSync(root)
  const entries = []

  function visit(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const full = path.join(directory, name)
      const relative = path.relative(physicalRoot, full)
      const stat = fs.lstatSync(full, { bigint: true })
      const type = stat.isSymbolicLink()
        ? 'symlink'
        : stat.isDirectory()
          ? 'directory'
          : stat.isFile()
            ? 'file'
            : 'other'
      if (exclude(relative, type)) continue
      const entry = {
        path: relative,
        type,
        mode: Number(stat.mode & 0o7777n),
      }
      if (type === 'file') entry.size = stat.size.toString()
      if (type === 'symlink') entry.target = fs.readlinkSync(full)
      if (includeMtime && type !== 'directory') entry.mtime_ns = stat.mtimeNs.toString()
      entries.push(entry)
      if (type === 'directory') visit(full)
    }
  }

  visit(physicalRoot)
  return {
    count: entries.length,
    sha256: crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
  }
}

export function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} mismatch`)
  }
}

export function assertInspectionHealthy(inspection, label) {
  assertEqual(inspection.quick_check, ['ok'], `${label} quick_check`)
  if (inspection.foreign_key_error_count !== 0) {
    throw new Error(`${label} has foreign-key errors`)
  }
}

export function assertProtectedStateEqual(actual, expected, label) {
  assertEqual(actual.protected_saves, expected.protected_saves, `${label} protected saves`)
  assertEqual(actual.protected_tables, expected.protected_tables, `${label} protected tables`)
  assertEqual(actual.paths.values_sha256, expected.paths.values_sha256, `${label} path values`)
  assertEqual(actual.paths.media_sha256, expected.paths.media_sha256, `${label} mapped media`)
  assertEqual(actual.save_count, expected.save_count, `${label} save count`)
  assertEqual(actual.active_save_count, expected.active_save_count, `${label} active save count`)
}

export function sanitizedRunnerReceipt(receipt) {
  const report = receipt.migration_report
    ? {
        ...receipt.migration_report,
        backupPath: receipt.migration_report.backupPath
          ? path.basename(receipt.migration_report.backupPath)
          : null,
      }
    : null
  return {
    migration_report: report,
    total_changes: receipt.total_changes,
    inspection: receipt.inspection,
    loaded_app_modules: receipt.loaded_app_modules,
    blocked_attempts: receipt.blocked_attempts,
    listening_handles: receipt.listening_handles,
  }
}
