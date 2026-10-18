// Android 原生功能封裝;在一般瀏覽器預覽時會自動退回網頁版本或停用。
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Clipboard } from '@capacitor/clipboard';
import { Share } from '@capacitor/share';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { PrivacyScreen } from '@capacitor-community/privacy-screen';
import { BiometricAuth } from '@aparajita/capacitor-biometric-auth';
import { SecureStorage } from '@aparajita/capacitor-secure-storage';

export const isNative = Capacitor.isNativePlatform();
const MK = 'aihi.masterkey';
let clipTimer = null;

export async function copyText(text, clearAfterMs) {
  if (isNative) await Clipboard.write({ string: text });
  else await navigator.clipboard.writeText(text);
  clearTimeout(clipTimer);
  if (clearAfterMs) {
    clipTimer = setTimeout(() => {
      (isNative ? Clipboard.write({ string: '' }) : navigator.clipboard.writeText('')).catch(() => {});
    }, clearAfterMs);
  }
}

export async function setPrivacyScreen(on) {
  if (!isNative) return;
  try {
    await (on ? PrivacyScreen.enable() : PrivacyScreen.disable());
  } catch { /* 忽略 */ }
}

export async function biometricAvailable() {
  if (!isNative) return false;
  try {
    return (await BiometricAuth.checkBiometry()).isAvailable;
  } catch {
    return false;
  }
}

async function verifyFinger(reason) {
  await BiometricAuth.authenticate({
    reason,
    cancelTitle: '取消',
    allowDeviceCredential: false,
    androidTitle: '藍緋',
    androidSubtitle: reason,
  });
}

export async function enableBiometric(masterPassword) {
  await verifyFinger('啟用指紋解鎖');
  await SecureStorage.set(MK, masterPassword);
}

export async function readBiometricPassword() {
  await verifyFinger('解鎖藍緋');
  return SecureStorage.get(MK);
}

export async function updateBiometricPassword(masterPassword) {
  await SecureStorage.set(MK, masterPassword);
}

export async function disableBiometric() {
  try {
    await SecureStorage.remove(MK);
  } catch { /* 忽略 */ }
}

export async function shareFile(filename, text) {
  if (!isNative) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    return;
  }
  const { uri } = await Filesystem.writeFile({
    path: filename,
    data: text,
    directory: Directory.Cache,
    encoding: Encoding.UTF8,
  });
  await Share.share({ title: '藍緋備份', files: [uri], dialogTitle: '儲存或傳送備份檔' });
}

export function onBackButton(handler) {
  if (isNative) App.addListener('backButton', handler);
}
export const minimizeApp = () => App.minimizeApp();
