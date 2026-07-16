'use strict';

const USER_OWNED_PROVIDERS = new Set(['codex', 'local', 'ollama']);
const BRETT_OWNED_PROVIDERS = new Set(['gatheros-proxy']);

function providerAccess(provider) {
  if (USER_OWNED_PROVIDERS.has(provider)) {
    return { ownership: 'user', requiresPro: false };
  }
  if (BRETT_OWNED_PROVIDERS.has(provider)) {
    return { ownership: 'gatheros', requiresPro: true };
  }
  return { ownership: 'unknown', requiresPro: true };
}

function createGatherLocalAuthorization({ getEntitlement } = {}) {
  const resolveEntitlement = getEntitlement || (() => require('../../entitlement').getEntitlement());
  return ({ provider } = {}) => {
    const access = providerAccess(provider);
    if (access.ownership === 'user') return { allowed: true, ...access };
    if (access.ownership !== 'gatheros') return { allowed: false, ...access };
    return { allowed: Boolean(resolveEntitlement()?.proUnlocked), ...access };
  };
}

module.exports = {
  createGatherLocalAuthorization,
  providerAccess,
};
