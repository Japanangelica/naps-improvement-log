// 加密保險庫:整份資料以 AES-256-GCM 加密後存在手機本機,金鑰由主密碼經 PBKDF2 衍生。
const STORE_KEY = 'aihi.vault.v1';
const ITERATIONS = 600000;

export const OTHER = 'other';
export const DEFAULT_CATEGORIES = [
  { id: 'work', name: '公事', color: '#26325e', secret: false },
  { id: 'shop', name: '商場', color: '#d98a1c', secret: false },
  { id: 'bank', name: '銀行', color: '#a12a2a', secret: true },
  { id: 'utility', name: '公共', color: '#2f6f73', secret: false },
  { id: 'social', name: '社交軟體', color: '#7a3b69', secret: false },
  { id: 'media', name: '影音', color: '#e8452c', secret: false },
  { id: OTHER, name: '其他', color: '#7d6b66', secret: false },
];
const PALETTE = ['#3b4d8f', '#b8531f', '#2f6f73', '#7a3b69', '#d98a1c', '#a12a2a'];
const defaults = () => DEFAULT_CATEGORIES.map((c) => ({ ...c }));

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

async function seal(key, payload) {
  const iv = rand(12);
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(payload)));
  return { iv: b64(iv), data: b64(data) };
}

async function open(key, box) {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.data));
  return normalize(JSON.parse(dec.decode(plain)));
}

// 舊版(v1)只存記錄陣列;新版存 { records, categories }
function normalize(data) {
  if (Array.isArray(data)) return { records: data, categories: defaults() };
  return {
    records: data.records || [],
    categories: data.categories && data.categories.length ? data.categories : defaults(),
  };
}

let session = null; // { key, salt, iter, records, categories }

export const hasVault = () => !!localStorage.getItem(STORE_KEY);
export const isUnlocked = () => !!session;
export const lock = () => { session = null; };

async function persist() {
  const box = await seal(session.key, { records: session.records, categories: session.categories });
  localStorage.setItem(
    STORE_KEY,
    JSON.stringify({ v: 2, iter: session.iter, salt: b64(session.salt), ...box }),
  );
}

export async function createVault(password) {
  const salt = rand(16);
  session = { key: await derive(password, salt, ITERATIONS), salt, iter: ITERATIONS, records: [], categories: defaults() };
  await persist();
}

// 密碼錯誤時 decrypt 會丟出例外
export async function unlock(password) {
  const raw = JSON.parse(localStorage.getItem(STORE_KEY));
  const salt = unb64(raw.salt);
  const key = await derive(password, salt, raw.iter);
  const { records, categories } = await open(key, raw);
  session = { key, salt, iter: raw.iter, records, categories };
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

export const categories = () => session.categories.slice();
export const categoryOf = (id) =>
  session.categories.find((c) => c.id === id) || session.categories.find((c) => c.id === OTHER) || DEFAULT_CATEGORIES[6];
export const isSecret = (rec) => categoryOf(rec.category).secret;

export async function saveCategories(next) {
  session.categories = next;
  await persist();
}

export async function addCategory(name, secret) {
  const color = PALETTE[session.categories.length % PALETTE.length];
  session.categories.splice(-1, 0, { id: `c${crypto.randomUUID().slice(0, 8)}`, name, color, secret });
  await persist();
}

// 刪除分類時,其下記錄移到「其他」
export async function removeCategory(id) {
  if (id === OTHER) return;
  session.categories = session.categories.filter((c) => c.id !== id);
  for (const r of session.records) if (r.category === id) r.category = OTHER;
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
  const { records: incoming, categories: inCats } = await open(await derive(password, unb64(raw.salt), raw.iter), raw);
  for (const c of inCats) if (!session.categories.some((m) => m.id === c.id)) session.categories.splice(-1, 0, c);
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
