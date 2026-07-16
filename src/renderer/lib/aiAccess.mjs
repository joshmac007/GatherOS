export function canUseCapability(access) {
  return !!access?.configured && access.ownership === 'user';
}
