'use strict';

class LocalMigrationError extends Error {
  constructor(code, message, {
    phase,
    migrationId,
    cause,
    backupPath,
  } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'LocalMigrationError';
    this.code = code;
    this.phase = phase || null;
    this.migrationId = migrationId || null;
    this.backupPath = backupPath || null;
  }
}

module.exports = { LocalMigrationError };
