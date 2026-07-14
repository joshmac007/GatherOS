'use strict';

const os = require('node:os');
const path = require('node:path');

const APP_NAME = 'GatherLocal';
const APP_ID = 'com.gatherlocal.app';
const URL_SCHEME = 'gatherlocal';
const NATIVE_HOST_NAME = 'co.gatherlocal.host';
const EXTENSION_IDS = Object.freeze(['ffeaogljbgkjmbjkbpdfhdcdlomlbbpe']);
const CAPTURE_HOST = '127.0.0.1';
const CAPTURE_PORT = 53248;
const BACKGROUND_LAUNCH_ARG = '--gatherlocal-bg';

function defaultUserDataDir({
  platform = process.platform,
  home = os.homedir(),
  env = process.env,
} = {}) {
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', APP_NAME);
  }
  if (platform === 'win32') {
    return path.join(env.APPDATA || '', APP_NAME);
  }
  if (platform === 'linux') {
    return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), APP_NAME);
  }
  return null;
}

module.exports = {
  APP_NAME,
  APP_ID,
  URL_SCHEME,
  NATIVE_HOST_NAME,
  EXTENSION_IDS,
  CAPTURE_HOST,
  CAPTURE_PORT,
  BACKGROUND_LAUNCH_ARG,
  defaultUserDataDir,
};
