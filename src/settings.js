const KEY = 'aihi.settings';
const defaults = { lockSec: 120, biometric: false, privacy: true, clipClear: true };

export function getSettings() {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...defaults };
  }
}

export function setSettings(patch) {
  const next = { ...getSettings(), ...patch };
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}
