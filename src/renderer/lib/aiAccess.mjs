export function canUseCapability(access, proLocked) {
  if (!access?.configured) return false;
  return !access.requiresPro || !proLocked;
}

export function capabilityRequiresUpgrade(access, proLocked) {
  if (!proLocked) return false;
  return access ? !!access.requiresPro : true;
}
