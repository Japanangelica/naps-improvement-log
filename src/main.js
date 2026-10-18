import './style.css';
import * as vault from './vault.js';
import * as native from './native.js';
import { icon } from './icons.js';
import { getSettings, setSettings } from './settings.js';

const app = document.getElementById('app');
const CLIP_MS = 30000;
const AVATARS = ['#26325e', '#e8452c', '#a12a2a', '#3b4d8f', '#d98a1c', '#7a3b69', '#2f6f73', '#b8531f'];

/* ---------- 小工具 ---------- */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v; // 僅用於 icons.js 的常數圖示
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return el;
}
const ico = (name, cls) => h('span', { class: cls || 'ico', html: icon[name], style: 'display:contents' });

function toast(msg) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = h('div', { class: 'toast' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 2300);
}

function colorFor(name) {
  let n = 0;
  for (const c of name) n = (n * 31 + c.codePointAt(0)) >>> 0;
  return AVATARS[n % AVATARS.length];
}
const initial = (name) => ([...name.trim()][0] || '?').toUpperCase();
const avatar = (name) => h('div', { class: 'avatar', style: `background:${colorFor(name)}` }, initial(name));

function show(el) {
  app.replaceChildren(el);
}

function passwordField(label, props = {}) {
  const input = h('input', { type: 'password', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', ...props });
  const eye = h('button', { type: 'button', class: 'ib', 'aria-label': '顯示或隱藏' }, ico('eye'));
  eye.onclick = () => {
    const hidden = input.type === 'password';
    input.type = hidden ? 'text' : 'password';
    eye.replaceChildren(ico(hidden ? 'eyeOff' : 'eye'));
  };
  const root = h('div', { class: 'field' }, h('label', {}, label), h('div', { class: 'input-wrap' }, input, eye));
  return { root, input };
}

function dialog({ title, text, body, confirm = '確定', cancel = '取消', danger = false }) {
  return new Promise((resolve) => {
    const done = (v) => { scrim.remove(); resolve(v); };
    const scrim = h(
      'div', { class: 'scrim', onclick: (e) => e.target === scrim && done(false) },
      h('div', { class: 'dialog' },
        h('h4', {}, title), text && h('p', {}, text), body,
        h('div', { class: 'btns' },
          cancel && h('button', { class: 'btn ghost', onclick: () => done(false) }, cancel),
          h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => done(true) }, confirm))),
    );
    document.body.append(scrim);
    scrim.querySelector('input')?.focus();
  });
}

const sheets = [];
function openSheet(build) {
  const el = h('div', { class: 'sheet' });
  const api = {
    el,
    close() {
      const i = sheets.indexOf(api);
      if (i >= 0) sheets.splice(i, 1);
      el.classList.add('out');
      setTimeout(() => el.remove(), 190);
    },
  };
  build(el, api);
  sheets.push(api);
  document.body.append(el);
  return api;
}
const closeAllSheets = () => { while (sheets.length) sheets.pop().el.remove(); document.querySelectorAll('.scrim').forEach((s) => s.remove()); };

/* ---------- 自動上鎖 ---------- */
let idleTimer = null;
let hiddenAt = 0;
function armIdle() {
  clearTimeout(idleTimer);
  const { lockSec } = getSettings();
  if (vault.isUnlocked() && lockSec > 0) idleTimer = setTimeout(lockNow, lockSec * 1000);
}
['pointerdown', 'keydown', 'scroll'].forEach((e) => document.addEventListener(e, armIdle, { passive: true, capture: true }));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) hiddenAt = Date.now();
  else if (vault.isUnlocked()) {
    const { lockSec } = getSettings();
    if (lockSec > 0 && Date.now() - hiddenAt > Math.min(lockSec, 15) * 1000) lockNow();
  }
});
function lockNow() {
  clearTimeout(idleTimer);
  vault.lock();
  closeAllSheets();
  renderLock();
}

/* ---------- 初次設定 ---------- */
function hero(title, sub, iconName) {
  return h('div', { class: 'hero' }, h('div', { class: 'badge' }, ico(iconName)), h('h1', {}, title), h('p', {}, sub));
}

function renderSetup() {
  const pw = passwordField('主密碼', { placeholder: '至少 8 個字元' });
  const pw2 = passwordField('再次輸入主密碼');
  const agree = h('input', { type: 'checkbox' });
  const err = h('div', { class: 'error' });
  const go = h('button', { class: 'btn primary' }, '建立保險庫');
  go.onclick = async () => {
    if (pw.input.value.length < 8) return (err.textContent = '主密碼至少需要 8 個字元');
    if (pw.input.value !== pw2.input.value) return (err.textContent = '兩次輸入的主密碼不一致');
    if (!agree.checked) return (err.textContent = '請先勾選確認事項');
    go.disabled = true;
    go.textContent = '建立中…';
    await vault.createVault(pw.input.value);
    afterUnlock();
  };
  show(h('div', { class: 'screen' },
    hero('藍緋', '悄悄收好您的鑰匙', 'key'),
    h('div', { class: 'panel' },
      h('div', { class: 'hint' }, '首次使用,請設定一組主密碼。所有資料只會加密保存在這支手機內,不會連網。'),
      pw.root, pw2.root,
      h('label', { class: 'check' }, agree, '我了解:忘記主密碼將無法復原資料,建議定期匯出備份。'),
      err, go)));
}

/* ---------- 鎖定畫面 ---------- */
let fails = 0;
let lockedUntil = 0;
async function renderLock(autoFinger = true) {
  const pw = passwordField('主密碼', { placeholder: '輸入主密碼解鎖' });
  const err = h('div', { class: 'error' });
  const go = h('button', { class: 'btn primary' }, '解鎖');
  const tryUnlock = async (password) => {
    const wait = lockedUntil - Date.now();
    if (wait > 0) return (err.textContent = `嘗試過多,請 ${Math.ceil(wait / 1000)} 秒後再試`);
    go.disabled = true;
    try {
      await vault.unlock(password);
      fails = 0;
      afterUnlock();
    } catch {
      fails++;
      if (fails >= 5) lockedUntil = Date.now() + Math.min(2 ** (fails - 4), 60) * 1000;
      err.textContent = '主密碼錯誤';
      go.disabled = false;
      pw.input.select();
    }
  };
  go.onclick = () => tryUnlock(pw.input.value);
  pw.input.addEventListener('keydown', (e) => e.key === 'Enter' && go.click());

  const useFinger = async () => {
    try {
      const saved = await native.readBiometricPassword();
      if (!saved) throw new Error('empty');
      await tryUnlock(saved);
    } catch {
      err.textContent = '指紋驗證未完成,請輸入主密碼';
    }
  };
  const fingerOn = getSettings().biometric && native.isNative;
  show(h('div', { class: 'screen' },
    hero('藍緋', '已鎖定', 'lock'),
    h('div', { class: 'panel' }, pw.root, err, go,
      fingerOn && h('button', { class: 'btn finger', 'aria-label': '指紋解鎖', onclick: useFinger }, ico('fingerprint')))));
  if (fingerOn && autoFinger) useFinger();
}

function afterUnlock() {
  armIdle();
  renderList();
}

/* ---------- 清單 ---------- */
let query = '';
function norm(s) {
  return (s || '').normalize('NFKC').toLowerCase();
}

function renderList() {
  const search = h('input', { type: 'search', placeholder: '搜尋名稱、帳號或備註', value: query, autocomplete: 'off' });
  const clear = h('button', { class: 'clear', 'aria-label': '清除' }, ico('x'));
  const list = h('div', { class: 'list' });
  const count = h('div', { class: 'sub' });

  const paint = () => {
    const q = norm(query.trim());
    const all = vault.list().sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
    const rows = q ? all.filter((r) => norm(`${r.name}\n${r.account}\n${r.note}`).includes(q)) : all;
    count.textContent = q ? `找到 ${rows.length} / ${all.length} 筆` : `共 ${all.length} 筆記錄`;
    clear.style.display = query ? '' : 'none';
    list.replaceChildren();
    if (!rows.length) {
      list.append(h('div', { class: 'empty' },
        h('div', { class: 'art' }, ico(all.length ? 'search' : 'key')),
        all.length ? h('b', {}, '找不到符合的記錄') : h('b', {}, '還沒有任何記錄'),
        all.length ? '換個關鍵字試試看' : '點右下角「＋」新增第一筆帳號密碼'));
      return;
    }
    rows.forEach((r, i) => {
      const card = h('button', { class: 'card', style: `animation-delay:${Math.min(i, 8) * 30}ms`, onclick: () => openDetail(r.id) },
        avatar(r.name),
        h('div', { class: 'meta' }, h('div', { class: 'name' }, r.name), h('div', { class: 'acct' }, r.account || '—')),
        ico('chevron'));
      list.append(card);
    });
  };
  search.oninput = () => { query = search.value; paint(); };
  clear.onclick = () => { query = ''; search.value = ''; paint(); search.focus(); };

  const screen = h('div', { class: 'screen' },
    h('div', { class: 'top' },
      h('div', { class: 'row' },
        h('div', {}, h('h1', {}, '藍緋'), count),
        h('div', { class: 'actions' },
          h('button', { class: 'round', 'aria-label': '設定', onclick: openSettings }, ico('sliders')),
          h('button', { class: 'round', 'aria-label': '立即上鎖', onclick: lockNow }, ico('lock')))),
      h('div', { class: 'search' }, ico('search'), search, clear)),
    list,
    h('button', { class: 'fab', 'aria-label': '新增', onclick: () => openEditor() }, ico('plus')));
  show(screen);
  screen.repaint = paint;
  paint();
  renderList.current = paint;
}
const refreshList = () => renderList.current && renderList.current();

/* ---------- 詳細 ---------- */
function copyItem(label, value) {
  return async () => {
    try {
      await native.copyText(value, getSettings().clipClear ? CLIP_MS : 0);
      toast(getSettings().clipClear ? `已複製${label},30 秒後自動清除` : `已複製${label}`);
    } catch {
      toast('複製失敗');
    }
  };
}

function openDetail(id) {
  openSheet((el, sheet) => {
    const rec = vault.get(id);
    let shown = false;
    const pwVal = h('div', { class: 'val mono' }, '••••••••••');
    const eye = h('button', { class: 'ib', 'aria-label': '顯示密碼' }, ico('eye'));
    eye.onclick = () => {
      shown = !shown;
      pwVal.textContent = shown ? rec.password : '••••••••••';
      eye.replaceChildren(ico(shown ? 'eyeOff' : 'eye'));
    };
    const row = (lbl, val, extra) => h('div', { class: 'item' }, h('div', { class: 'txt' }, h('div', { class: 'lbl' }, lbl), val), extra);
    el.append(
      h('div', { class: 'bar' },
        h('button', { class: 'ib', 'aria-label': '返回', onclick: sheet.close }, ico('back')),
        h('h2', {}, '詳細資料'),
        h('button', { class: 'ib', 'aria-label': '編輯', onclick: () => { sheet.close(); openEditor(id); } }, ico('edit'))),
      h('div', { class: 'body' },
        h('div', { class: 'id-head' }, avatar(rec.name), h('h3', {}, rec.name)),
        h('div', { class: 'group' },
          row('帳號', h('div', { class: 'val' }, rec.account || '—'),
            rec.account && h('button', { class: 'ib', 'aria-label': '複製帳號', onclick: copyItem('帳號', rec.account) }, ico('copy'))),
          row('密碼', pwVal, [eye, h('button', { class: 'ib', 'aria-label': '複製密碼', onclick: copyItem('密碼', rec.password) }, ico('copy'))])),
        rec.note && h('div', { class: 'group' }, row('備註', h('div', { class: 'val note' }, rec.note))),
        h('div', { class: 'hint', style: 'text-align:center' }, `更新於 ${new Date(rec.updatedAt).toLocaleString('zh-TW')}`),
        h('button', {
          class: 'btn danger',
          onclick: async () => {
            if (await dialog({ title: '刪除這筆記錄?', text: `「${rec.name}」將被永久刪除,無法復原。`, confirm: '刪除', danger: true })) {
              await vault.remove(id);
              sheet.close();
              refreshList();
              toast('已刪除');
            }
          },
        }, ico('trash'), '刪除記錄')));
  });
}

/* ---------- 新增 / 編輯 ---------- */
function genPassword(len = 16) {
  const sets = ['abcdefghijkmnopqrstuvwxyz', 'ABCDEFGHJKLMNPQRSTUVWXYZ', '23456789', '!@#$%^&*-_=+?'];
  const all = sets.join('');
  const pick = (s) => s[crypto.getRandomValues(new Uint32Array(1))[0] % s.length];
  const out = sets.map(pick);
  while (out.length < len) out.push(pick(all));
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join('');
}

function openEditor(id) {
  const rec = id ? vault.get(id) : { name: '', account: '', password: '', note: '' };
  openSheet((el, sheet) => {
    const name = h('input', { placeholder: '例如:Gmail、蝦皮、公司系統', value: rec.name, maxlength: 80 });
    const account = h('input', { placeholder: '帳號或 Email', value: rec.account, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', maxlength: 200 });
    const pw = passwordField('密碼', { value: rec.password, maxlength: 500 });
    const dice = h('button', { type: 'button', class: 'ib', 'aria-label': '產生隨機密碼' }, ico('dice'));
    dice.onclick = () => { pw.input.value = genPassword(); pw.input.type = 'text'; toast('已產生隨機密碼'); };
    pw.root.querySelector('.input-wrap').append(dice);
    const note = h('textarea', { placeholder: '網址、安全問題、其他備忘…', maxlength: 2000 });
    note.value = rec.note;
    const err = h('div', { class: 'error' });
    const field = (label, ctrl) => h('div', { class: 'field' }, h('label', {}, label), h('div', { class: 'input-wrap' }, ctrl));

    const saveBtn = h('button', { class: 'btn primary' }, ico('check'), '儲存');
    saveBtn.onclick = async () => {
      if (!name.value.trim()) return (err.textContent = '請輸入名稱');
      if (!pw.input.value) return (err.textContent = '請輸入密碼');
      saveBtn.disabled = true;
      await vault.save({ id, name: name.value.trim(), account: account.value.trim(), password: pw.input.value, note: note.value.trim() });
      sheet.close();
      refreshList();
      toast('已儲存');
    };
    el.append(
      h('div', { class: 'bar' },
        h('button', { class: 'ib', 'aria-label': '取消', onclick: sheet.close }, ico('x')),
        h('h2', {}, id ? '編輯記錄' : '新增記錄')),
      h('div', { class: 'body' }, field('名稱', name), field('帳號', account), pw.root, field('備註', note), err, saveBtn));
    if (!id) setTimeout(() => name.focus(), 300);
  });
}

/* ---------- 設定 ---------- */
function openSettings() {
  openSheet((el, sheet) => {
    const body = h('div', { class: 'body' });
    const paint = async () => {
      const s = getSettings();
      const fingerOk = await native.biometricAvailable();
      const toggle = (on) => h('div', { class: `sw${on ? ' on' : ''}` });
      const rowEl = (ic, title, sub, right, onclick) =>
        h(onclick ? 'button' : 'div', { class: 'row-set', onclick }, h('div', { class: 'ic' }, ico(ic)), h('div', { class: 't' }, title, sub && h('small', {}, sub)), right);

      const lockSel = h('select', { onchange: (e) => { setSettings({ lockSec: Number(e.target.value) }); armIdle(); } },
        [[30, '30 秒'], [60, '1 分鐘'], [120, '2 分鐘'], [300, '5 分鐘'], [0, '不自動']].map(([v, t]) => h('option', { value: v, selected: v === s.lockSec }, t)));

      body.replaceChildren(
        h('div', { class: 'sec-title' }, '安全'),
        h('div', { class: 'group' },
          rowEl('fingerprint', '指紋解鎖', fingerOk ? '用指紋取代輸入主密碼' : native.isNative ? '此裝置尚未設定指紋' : '僅 Android App 可用', toggle(s.biometric && fingerOk),
            fingerOk ? async () => {
              if (s.biometric) { await native.disableBiometric(); setSettings({ biometric: false }); toast('已關閉指紋解鎖'); return paint(); }
              const pw = passwordField('請輸入目前的主密碼');
              if (!(await dialog({ title: '啟用指紋解鎖', body: pw.root, confirm: '啟用' }))) return;
              if (!(await vault.verifyPassword(pw.input.value))) return toast('主密碼錯誤');
              try {
                await native.enableBiometric(pw.input.value);
                setSettings({ biometric: true });
                toast('已啟用指紋解鎖');
              } catch { toast('指紋驗證未完成'); }
              paint();
            } : null),
          rowEl('lock', '閒置自動上鎖', null, lockSel),
          rowEl('shield', '防止截圖與錄影', '同時隱藏多工畫面預覽', toggle(s.privacy), async () => {
            setSettings({ privacy: !s.privacy });
            await native.setPrivacyScreen(!s.privacy);
            paint();
          }),
          rowEl('copy', '複製後 30 秒清除剪貼簿', null, toggle(s.clipClear), () => { setSettings({ clipClear: !s.clipClear }); paint(); }),
          rowEl('key', '變更主密碼', null, ico('chevron'), changePw)),
        h('div', { class: 'sec-title' }, '備份'),
        h('div', { class: 'group' },
          rowEl('download', '匯出加密備份', '以目前主密碼加密,可存到雲端或傳給自己', ico('chevron'), doExport),
          rowEl('upload', '匯入備份', '合併備份檔中的記錄', ico('chevron'), doImport)),
        h('div', { class: 'hint', style: 'text-align:center;margin-top:8px' }, '藍緋 v1.0 ・ 所有資料僅保存在本機'));
    };
    el.append(
      h('div', { class: 'bar' }, h('button', { class: 'ib', 'aria-label': '返回', onclick: sheet.close }, ico('back')), h('h2', {}, '設定')),
      body);
    paint();
  });
}

async function changePw() {
  const cur = passwordField('目前的主密碼');
  const n1 = passwordField('新的主密碼(至少 8 字元)');
  const n2 = passwordField('再次輸入新主密碼');
  const body = h('div', { style: 'display:flex;flex-direction:column;gap:12px' }, cur.root, n1.root, n2.root);
  if (!(await dialog({ title: '變更主密碼', body, confirm: '變更' }))) return;
  if (!(await vault.verifyPassword(cur.input.value))) return toast('目前的主密碼錯誤');
  if (n1.input.value.length < 8) return toast('新主密碼至少 8 個字元');
  if (n1.input.value !== n2.input.value) return toast('兩次輸入的新主密碼不一致');
  await vault.changePassword(n1.input.value);
  if (getSettings().biometric) await native.updateBiometricPassword(n1.input.value).catch(() => {});
  toast('主密碼已變更');
}

async function doExport() {
  const name = `aihi-backup-${new Date().toISOString().slice(0, 10)}.json`;
  try {
    await native.shareFile(name, vault.exportText());
  } catch (e) {
    if (!/cancel/i.test(String(e))) toast('匯出失敗');
  }
}

function doImport() {
  const input = h('input', { type: 'file', accept: '.json,application/json', style: 'display:none' });
  input.onchange = async () => {
    const file = input.files[0];
    input.remove();
    if (!file) return;
    const text = await file.text();
    const pw = passwordField('備份檔的主密碼');
    if (!(await dialog({ title: '匯入備份', text: '請輸入建立該備份時使用的主密碼。', body: pw.root, confirm: '匯入' }))) return;
    try {
      const { added, updated } = await vault.importText(text, pw.input.value);
      refreshList();
      toast(`匯入完成:新增 ${added} 筆,更新 ${updated} 筆`);
    } catch {
      toast('匯入失敗:檔案格式或主密碼不正確');
    }
  };
  document.body.append(input);
  input.click();
}

/* ---------- 啟動 ---------- */
native.onBackButton(() => {
  if (document.querySelector('.scrim')) return document.querySelector('.scrim').remove();
  if (sheets.length) return sheets[sheets.length - 1].close();
  native.minimizeApp();
});
native.setPrivacyScreen(getSettings().privacy);
if (vault.hasVault()) renderLock();
else renderSetup();
