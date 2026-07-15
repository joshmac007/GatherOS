#!/usr/bin/env node
'use strict';

const childProcess = require('node:child_process');
const dgram = require('node:dgram');
const fs = require('node:fs');
const http = require('node:http');
const http2 = require('node:http2');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const tls = require('node:tls');
const { app } = require('electron');
const { inspectOpenDatabase } = require('../lib/sqlite-inspection.cjs');

const requiredEnvironment = [
  'GATHERLOCAL_REHEARSAL_APP_SOURCE',
  'GATHERLOCAL_REHEARSAL_CONTRACT',
  'GATHERLOCAL_REHEARSAL_USER_DATA',
  'GATHERLOCAL_REHEARSAL_RUN_ROOT',
  'GATHERLOCAL_REHEARSAL_SENTINEL',
  'GATHERLOCAL_REHEARSAL_RECEIPT',
  'GATHERLOCAL_REHEARSAL_SESSION',
  'GATHERLOCAL_REHEARSAL_LOGS',
  'GATHERLOCAL_REHEARSAL_CRASHES',
  'GATHERLOCAL_REHEARSAL_HOME',
];

for (const name of requiredEnvironment) {
  if (!process.env[name]) throw new Error(`${name} is required`);
}

const appSource = fs.realpathSync(process.env.GATHERLOCAL_REHEARSAL_APP_SOURCE);
const userData = fs.realpathSync(process.env.GATHERLOCAL_REHEARSAL_USER_DATA);
const runRoot = fs.realpathSync(process.env.GATHERLOCAL_REHEARSAL_RUN_ROOT);
const contractPath = fs.realpathSync(process.env.GATHERLOCAL_REHEARSAL_CONTRACT);
const sentinelPath = fs.realpathSync(process.env.GATHERLOCAL_REHEARSAL_SENTINEL);
const receiptPath = path.resolve(process.env.GATHERLOCAL_REHEARSAL_RECEIPT);
const sessionPath = fs.realpathSync(process.env.GATHERLOCAL_REHEARSAL_SESSION);
const logsPath = fs.realpathSync(process.env.GATHERLOCAL_REHEARSAL_LOGS);
const crashesPath = fs.realpathSync(process.env.GATHERLOCAL_REHEARSAL_CRASHES);
const homePath = fs.realpathSync(process.env.GATHERLOCAL_REHEARSAL_HOME);
const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
const sentinel = JSON.parse(fs.readFileSync(sentinelPath, 'utf8'));

function inside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function insideOrEqual(parent, child) {
  return path.resolve(parent) === path.resolve(child) || inside(parent, child);
}

if (!inside(runRoot, userData) || !inside(runRoot, receiptPath)
  || !inside(runRoot, sessionPath) || !inside(runRoot, logsPath)
  || !inside(runRoot, crashesPath) || !inside(runRoot, homePath)) {
  throw new Error('rehearsal paths must stay inside run root');
}
if (sentinel.user_data_realpath !== userData || sentinel.run_root_realpath !== runRoot) {
  throw new Error('copy sentinel does not match rehearsal paths');
}
if (path.resolve(userData) === path.resolve(contract.snapshot.recorded_user_data_root)
  || inside(userData, contract.snapshot.recorded_user_data_root)
  || inside(contract.snapshot.recorded_user_data_root, userData)) {
  throw new Error('rehearsal user data overlaps live user data');
}

for (const relative of Object.keys(contract.snapshot.key_files)) {
  const lexical = path.resolve(userData, relative);
  if (!inside(userData, lexical)) throw new Error('rehearsal key file escapes copied user data');
  const stat = fs.lstatSync(lexical);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`rehearsal key file is not regular: ${relative}`);
  }
  if (!inside(userData, fs.realpathSync(lexical))) {
    throw new Error(`rehearsal key file escapes physical copied user data: ${relative}`);
  }
}

app.setName('GatherLocal data rehearsal');
app.disableHardwareAcceleration();
app.setPath('userData', userData);
app.setPath('sessionData', sessionPath);
app.setPath('crashDumps', crashesPath);
app.setAppLogsPath(logsPath);

const blockedAttempts = [];
function block(kind) {
  return function blockedOperation() {
    blockedAttempts.push(kind);
    throw new Error(`rehearsal blocked ${kind}`);
  };
}

function physicalWriteTarget(target) {
  const resolved = path.resolve(String(target));
  try {
    fs.lstatSync(resolved);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(resolved);
    if (parent === resolved) throw error;
    return path.join(physicalWriteTarget(parent), path.basename(resolved));
  }
  return fs.realpathSync(resolved);
}

function safelyAllowed(target, predicate) {
  try {
    return predicate(physicalWriteTarget(target));
  } catch {
    return false;
  }
}

global.fetch = block('fetch');
http.request = block('http.request');
http.get = block('http.get');
https.request = block('https.request');
https.get = block('https.get');
http2.connect = block('http2.connect');
net.connect = block('net.connect');
net.createConnection = block('net.createConnection');
net.Socket.prototype.connect = block('net.Socket.connect');
tls.connect = block('tls.connect');
dgram.createSocket = block('dgram.createSocket');
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  childProcess[name] = block(`child_process.${name}`);
}

function allowedDatabaseArtifact(target) {
  return safelyAllowed(target, physical => (
    inside(userData, physical) && path.basename(physical).startsWith('moodmark.db')
  ));
}

function allowedGeneralWrite(target) {
  return safelyAllowed(target, physical => (
    physical === receiptPath
      || inside(sessionPath, physical)
      || inside(logsPath, physical)
      || inside(crashesPath, physical)
      || inside(homePath, physical)
      || allowedDatabaseArtifact(physical)
  ));
}

function allowedDirectory(target) {
  return safelyAllowed(target, physical => (
    insideOrEqual(userData, physical)
      || insideOrEqual(sessionPath, physical)
      || insideOrEqual(logsPath, physical)
      || insideOrEqual(crashesPath, physical)
      || insideOrEqual(homePath, physical)
  ));
}

function guardSync(name, pathIndexes, allow = allowedGeneralWrite) {
  const original = fs[name];
  fs[name] = function guardedFsOperation(...args) {
    for (const index of pathIndexes) {
      if (!allow(args[index])) {
        blockedAttempts.push(`fs.${name}:${path.basename(String(args[index]))}`);
        throw new Error(`rehearsal blocked fs.${name}`);
      }
    }
    return original.apply(this, args);
  };
}

guardSync('mkdirSync', [0], allowedDirectory);
for (const name of ['writeFileSync', 'appendFileSync', 'truncateSync', 'unlinkSync', 'rmSync', 'rmdirSync', 'chmodSync', 'chownSync', 'utimesSync']) {
  guardSync(name, [0]);
}
for (const name of ['renameSync', 'copyFileSync', 'linkSync', 'symlinkSync']) {
  guardSync(name, [0, 1]);
}

const timeout = setTimeout(() => {
  try {
    fs.writeFileSync(receiptPath, `${JSON.stringify({ ok: false, error: 'rehearsal timed out' }, null, 2)}\n`);
  } catch {}
  app.exit(1);
}, 60000);

async function run() {
  let dbModule;
  try {
    await app.whenReady();
    const { initializePersistentState } = require(path.join(appSource, 'src/main/persistent-state'));
    const state = initializePersistentState();
    dbModule = require(path.join(appSource, 'src/main/db'));
    const migrationReport = dbModule.getMigrationReport();
    const totalChanges = state.database.prepare('SELECT total_changes() AS n').get().n;
    const inspection = inspectOpenDatabase(
      state.database,
      contract,
      userData,
      { hashMedia: true },
    );

    const loadedAppModules = Object.keys(require.cache)
      .filter(file => file.startsWith(`${appSource}${path.sep}`))
      .map(file => path.relative(appSource, file).split(path.sep).join('/'))
      .sort();
    const forbidden = contract.forbidden_app_modules.filter(module => loadedAppModules.includes(module));
    if (forbidden.length > 0) throw new Error(`forbidden app modules loaded: ${forbidden.join(', ')}`);
    if (blockedAttempts.length > 0) throw new Error(`blocked side effects were attempted: ${blockedAttempts.join(', ')}`);

    const listeningHandles = process._getActiveHandles()
      .filter(handle => handle && handle.listening === true)
      .map(handle => handle.constructor?.name || 'unknown');
    if (listeningHandles.length > 0) throw new Error(`listening handles remain: ${listeningHandles.join(', ')}`);

    dbModule.closeDatabase();
    dbModule = null;
    fs.writeFileSync(receiptPath, `${JSON.stringify({
      ok: true,
      migration_report: migrationReport,
      total_changes: totalChanges,
      inspection,
      loaded_app_modules: loadedAppModules,
      blocked_attempts: blockedAttempts,
      listening_handles: listeningHandles,
    }, null, 2)}\n`);
    clearTimeout(timeout);
    app.quit();
  } catch (error) {
    try { dbModule?.closeDatabase(); } catch {}
    try {
      fs.writeFileSync(receiptPath, `${JSON.stringify({
        ok: false,
        error: error?.stack || error?.message || String(error),
        blocked_attempts: blockedAttempts,
      }, null, 2)}\n`);
    } catch {}
    clearTimeout(timeout);
    app.exit(1);
  }
}

run();
