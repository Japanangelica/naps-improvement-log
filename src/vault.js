// 加密保險庫:整份資料以 AES-256-GCM 加密後存在手機本機,金鑰由主密碼經 PBKDF2 衍生。
const STORE_KEY = 'aihi.vault.v1';
const ITERATIONS = 600000;
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

async function derive(password, salt, iter) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function seal(key, records) {
  const iv = rand(12);
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(records)));
  return { iv: b64(iv), data: b64(data) };
}

async function open(key, box) {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.data));
  return JSON.parse(dec.decode(plain));
}

let session = null; // { key, salt, iter, records }

export const hasVault = () => !!localStorage.getItem(STORE_KEY);
export const isUnlocked = () => !!session;
export const lock = () => { session = null; };

async function persist() {
  const box = await seal(session.key, session.records);
  localStorage.setItem(
    STORE_KEY,
    JSON.stringify({ v: 1, iter: session.iter, salt: b64(session.salt), ...box }),
  );
}

export async function createVault(password) {
  const salt = rand(16);
  session = { key: await derive(password, salt, ITERATIONS), salt, iter: ITERATIONS, records: [] };
  await persist();
}

// 密碼錯誤時 decrypt 會丟出例外
export async function unlock(password) {
  const raw = JSON.parse(localStorage.getItem(STORE_KEY));
  const salt = unb64(raw.salt);
  const key = await derive(password, salt, raw.iter);
  const records = await open(key, raw);
  session = { key, salt, iter: raw.iter, records };
}

export async function verifyPassword(password) {
  const raw = JSON.parse(localStorage.getItem(STORE_KEY));
  try {
    await open(await derive(password, unb64(raw.salt), raw.iter), raw);
    return true;
  } catch {
    return false;
  }
}

export async function changePassword(newPassword) {
  const salt = rand(16);
  session.salt = salt;
  session.iter = ITERATIONS;
  session.key = await derive(newPassword, salt, ITERATIONS);
  await persist();
}

export const list = () => session.records.slice();
export const get = (id) => session.records.find((r) => r.id === id);

export async function save(input) {
  const now = Date.now();
  const existing = input.id && get(input.id);
  if (existing) {
    Object.assign(existing, input, { updatedAt: now });
  } else {
    session.records.push({ ...input, id: crypto.randomUUID(), createdAt: now, updatedAt: now });
  }
  await persist();
}

export async function remove(id) {
  session.records = session.records.filter((r) => r.id !== id);
  await persist();
}

// 備份檔 = 以目前主密碼加密的保險庫
export function exportText() {
  return JSON.stringify({ app: 'aihi', ...JSON.parse(localStorage.getItem(STORE_KEY)) });
}

// 回傳 { added, updated };備份的主密碼可與目前不同
export async function importText(text, password) {
  const raw = JSON.parse(text);
  if (raw.app !== 'aihi' || !raw.salt || !raw.data) throw new Error('format');
  const incoming = await open(await derive(password, unb64(raw.salt), raw.iter), raw);
  let added = 0;
  let updated = 0;
  for (const rec of incoming) {
    const mine = get(rec.id);
    if (!mine) {
      session.records.push(rec);
      added++;
    } else if ((rec.updatedAt || 0) > (mine.updatedAt || 0)) {
      Object.assign(mine, rec);
      updated++;
    }
  }
  await persist();
  return { added, updated };
}
