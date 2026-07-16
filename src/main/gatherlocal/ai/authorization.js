'use strict';

const USER_OWNED_PROVIDERS = new Set(['codex', 'local', 'ollama']);

function providerAccess(provider) {
  if (USER_OWNED_PROVIDERS.has(provider)) {
    return { ownership: 'user', requiresPro: false };
  }
  return { ownership: 'unknown', requiresPro: true };
}

function createGatherLocalAuthorization() {
  return ({ provider } = {}) => {
    const access = providerAccess(provider);
    if (access.ownership === 'user') return { allowed: true, ...access };
    return { allowed: false, ...access };
  };
}

module.exports = {
  createGatherLocalAuthorization,
  providerAccess,
};
