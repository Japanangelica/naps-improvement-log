// 操作畫面。資料操作都交給 ops.js，這裡只負責顯示與收集輸入。
import * as L from './logic.js';
import { createOps } from './ops.js';
import { createMemoryStore, createDemoAuth } from './store-memory.js';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => '$' + Number(n || 0).toLocaleString('en-US');
const REMEMBER_KEY = 'deposit-accounts', DEMO_KEY = 'deposit-demo-v1';

const S = { store: null, auth: null, ops: null, user: null, settings: L.DEFAULT_SETTINGS, open: [], unsub: null,
  view: 'home', back: 'home', filter: 'all', q: '', history: null, cur: null, edit: null,
  table: { status: 'all', from: '', to: '', q: '', rows: null, sort: 'orderNo', desc: true } };
const canSell = () => S.user.role !== 'accountant';
const canPost = () => S.user.role === 'manager' || S.user.role === 'accountant';
const inv = () => S.settings.useInvoice !== false;

/* ---------- 共用 ---------- */

function toast(msg, bad) {
  const t = $('#toast');
  t.textContent = msg; t.className = bad ? 'bad' : '';
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.add('hide'), bad ? 6000 : 2500);
}

function showErr(e) {
  const msg = (e && e.message) || String(e);
  const box = !$('#modal').classList.contains('hide') ? $('#mErr') : $('#formErr');
  if (box) { box.innerHTML = `<div class="err" role="alert">${esc(msg)}</div>`; box.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  else toast(msg, true);
}

/** 執行動作：期間鎖住按鈕避免重複送出，失敗時顯示原因。成功回傳結果，失敗回傳 undefined。 */
async function run(btn, fn) {
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = '處理中…';
  $$('#mErr, #formErr').forEach(b => { b.innerHTML = ''; });
  try { return await fn(); } catch (e) { showErr(e); }
  finally { btn.disabled = false; btn.textContent = label; }
}

function openModal(html) {
  $('#modalBody').innerHTML = `<div id="mErr"></div>${html}`;
  $('#modal').classList.remove('hide');
  const first = $('#modalBody input:not([type=hidden])');
  if (first) first.focus();
}
function closeModal() { $('#modal').classList.add('hide'); $('#modalBody').innerHTML = ''; }

const field = (label, inner, hint = '') => `<label class="f"><span>${label}${hint ? ` <small>${hint}</small>` : ''}</span>${inner}</label>`;
const options = (group, list, selected) => `<div class="opts" data-group="${group}">${list.map(v =>
  `<button type="button" class="opt${v === selected ? ' on' : ''}" data-v="${esc(v)}">${esc(v)}</button>`).join('')}</div>`;
const picked = (root, group) => { const el = $(`[data-group="${group}"] .opt.on`, root); return el ? el.dataset.v : ''; };

/** 支付方式區塊：選到轉帳類時才顯示入金日與末五碼。 */
function payFields(selected = '') {
  return `<div data-pay>
    <label class="f" style="margin-bottom:4px"><span>支付方式</span></label>${options('method', S.settings.methods, selected)}
    <div class="grid2 transfer${L.isTransfer(selected) ? '' : ' hide'}">
      ${field('入金日', `<input type="date" class="payDate" value="${L.twNow().date}">`)}
      ${field('帳號末五碼', '<input class="payRef" inputmode="numeric" maxlength="20">', '選填')}
    </div></div>`;
}
function readPay(root) {
  const method = picked(root, 'method'), tr = L.isTransfer(method);
  return { method, payDate: tr ? $('.payDate', root).value : '', ref: tr ? $('.payRef', root).value : '' };
}

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------- 啟動與登入 ---------- */

async function boot() {
  let config = null;
  try { const r = await fetch('/__/firebase/init.json'); if (r.ok) config = await r.json(); } catch { /* 不在 Firebase Hosting 上 */ }
  if (config && config.projectId) {
    const { createFirebase } = await import('./store-firebase.js');
    ({ store: S.store, auth: S.auth } = await createFirebase(config));
  } else {
    S.store = createMemoryStore({
      load: () => { try { return JSON.parse(localStorage.getItem(DEMO_KEY)); } catch { return null; } },
      save: d => { try { localStorage.setItem(DEMO_KEY, JSON.stringify(d)); } catch { /* 無法儲存時仍可操作 */ } }
    });
    S.auth = createDemoAuth(S.store);
  }
  S.ops = createOps(S.store, { user: () => S.user, settings: () => S.settings });
  if (S.store.demo) await seedDemo();
  S.auth.onChange(u => onAuth(u).catch(e => { renderLogin(); toast(e.message, true); }));
}

async function seedDemo() {
  if ((await S.store.query('staff')).length) return;
  await S.store.set('staff', 'demo-manager', { uid: 'demo-manager', name: '示範經理', email: 'manager@demo', role: 'manager', active: true });
  await S.store.set('staff', 'demo-staff', { uid: 'demo-staff', name: '示範店員', email: 'staff@demo', role: 'staff', active: true });
  await S.store.set('staff', 'demo-accountant', { uid: 'demo-accountant', name: '示範會計', email: 'accountant@demo', role: 'accountant', active: true });
  await S.store.set('settings', 'main', L.DEFAULT_SETTINGS);
  S.user = { uid: 'demo-manager', name: '示範經理', role: 'manager' };
  const today = L.twNow().date, mk = (customer, phone, name, spec, price, amount, method, hold) => S.ops.createOrder({
    customer, phone, items: [{ name, spec, qty: 1, price }], payment: { method, amount }, source: '門市', holdUntil: L.addDays(today, hold) });
  await mk('範例 王先生', '0900000001', 'ARAI RX-7X', 'L 白', 19600, 3000, '現金', 30);
  const b = await mk('範例 陳小姐', '0900000002', 'RS TAICHI 手套', 'M 黑', 3200, 1000, '信用卡', 20);
  const c = await mk('範例 林先生', '0900000003', 'AGV K1 S', 'XL', 8800, 8800, '銀行轉帳', -2);
  await S.ops.setStage(b.orderNo, 'arrived');
  await S.ops.setStage(c.orderNo, 'notified');
  S.user = null;
}

async function onAuth(u) {
  $('#boot').classList.add('hide');
  if (S.unsub) { S.unsub(); S.unsub = null; }
  if (!u) { S.user = null; return renderLogin(); }
  const staff = await S.store.get('staff', u.uid);
  const settings = await S.store.get('settings', 'main');
  if (!staff) return settings ? renderBlocked(u) : renderInit(u);
  if (!staff.active) return renderBlocked(u);
  S.user = { ...staff, uid: u.uid };
  S.settings = { ...L.DEFAULT_SETTINGS, ...(settings || {}) };
  remember(u.email, staff.name);
  S.unsub = S.store.listen('orders', [['status', '==', 'active']], rows => {
    S.open = rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    if (S.view === 'home') renderList();
    if (S.view === 'table' && S.table.status === 'open') renderSheet();
  }, e => toast(e.message, true));
  $('#login').classList.add('hide'); $('#login').innerHTML = ''; $('#app').classList.remove('hide');
  $('#shop').textContent = S.settings.shopName; document.title = S.settings.shopName + ' 訂金管理';
  $('#who').textContent = `${staff.name}（${L.ROLE_LABEL[staff.role]}）`;
  $('#demoBar').classList.toggle('hide', !S.store.demo);
  go(canSell() ? 'home' : 'table');
}

function remembered() { try { return JSON.parse(localStorage.getItem(REMEMBER_KEY)) || []; } catch { return []; } }
function remember(email, name) {
  if (S.store.demo || !email) return;
  const list = remembered().filter(a => a.email !== email);
  list.unshift({ email, name });
  try { localStorage.setItem(REMEMBER_KEY, JSON.stringify(list.slice(0, 8))); } catch { /* 略過 */ }
}

function loginShell(html) {
  $('#app').classList.add('hide');
  const el = $('#login'); el.classList.remove('hide');
  el.innerHTML = `<div class="card"><h2>訂金管理</h2><div id="formErr"></div>${html}</div>`;
}

function renderLogin() {
  if (S.store.demo) {
    return loginShell(`<p>目前是<b>示範模式</b>，可以自由試用，資料不會上傳。</p>
      <button class="btn pri big" data-act="demoLogin" data-email="manager@demo">以示範經理登入</button>
      <button class="btn big" style="margin-top:10px" data-act="demoLogin" data-email="staff@demo">以示範店員登入</button>
      <button class="btn big" style="margin-top:10px" data-act="demoLogin" data-email="accountant@demo">以示範會計登入</button>`);
  }
  const acc = remembered();
  loginShell(`${acc.length ? `<label class="f" style="margin-bottom:4px"><span>點選自己的名字</span></label>
      <div class="opts">${acc.map(a => `<button class="opt" data-act="pickAccount" data-email="${esc(a.email)}">${esc(a.name)}</button>`).join('')}</div>` : ''}
    ${field('Email', '<input id="lgEmail" type="email" autocomplete="username">')}
    ${field('密碼', '<input id="lgPass" type="password" autocomplete="current-password">')}
    <button class="btn pri big" data-act="login">登入</button>
    <button class="btn ghost" data-act="forgot" style="width:100%">忘記密碼</button>`);
}

function renderInit(u) {
  loginShell(`<p>這是第一次使用。請建立第一位經理（就是您目前登入的帳號 ${esc(u.email)}）。</p>
    ${field('您的姓名', '<input id="inName">')}${field('店名', `<input id="inShop" value="${esc(L.DEFAULT_SETTINGS.shopName)}">`)}
    <button class="btn pri big" data-act="init" data-uid="${esc(u.uid)}" data-email="${esc(u.email)}">開始使用</button>
    <button class="btn ghost" data-act="logout" style="width:100%">登出</button>`);
}

function renderBlocked(u) {
  loginShell(`<p>帳號 ${esc(u.email)} 尚未開通或已停用，請聯絡經理。</p><button class="btn big" data-act="logout">登出</button>`);
}

/* ---------- 分頁 ---------- */

function go(view, arg) {
  S.view = view;
  if (view === 'home' || view === 'table') S.back = view;
  const tabs = (canSell() ? [['home', '訂金單']] : []).concat([['table', '總表'], ['report', '報表']], S.user.role === 'manager' ? [['settings', '設定']] : []);
  const cur = view === 'form' || view === 'detail' || view === 'done' ? S.back : view;
  $('#view').classList.toggle('wide', view === 'table');
  $('#tabs').innerHTML = tabs.map(t => `<button data-act="tab" data-v="${t[0]}" class="${t[0] === cur ? 'on' : ''}">${t[1]}</button>`).join('');
  window.scrollTo(0, 0);
  ({ home: renderHome, table: renderTable, form: renderForm, detail: renderDetail, done: renderDone, report: renderReport, settings: renderSettings })[view](arg);
}

/* ---------- 首頁：未取貨清單 ---------- */

function renderHome() {
  $('#view').innerHTML = `<button class="btn pri big" data-act="new">＋ 收訂金</button>
    <div class="card" style="margin-top:14px">
      <input id="q" type="search" placeholder="搜尋：電話、姓名、單號、商品" value="${esc(S.q)}" aria-label="搜尋訂金單">
      <div class="opts" id="chips" style="margin:12px 0 4px"></div><div class="mute" id="openSum"></div>
    </div><div id="list"></div><div id="hist"></div>`;
  renderList();
}

function orderCard(o, today) {
  const active = o.status === 'active';
  return `<button class="order" data-act="open" data-no="${esc(o.orderNo)}">
    <span class="who">${esc(o.customer)} <span class="mute num">${esc(o.phone)}</span></span>
    <span class="amt num">${money(active ? o.held : o.totalPrice)}</span>
    <span class="what">${esc(o.itemsText)}</span>
    <span class="meta">${active ? `<span class="pill ${o.stage}">${L.STAGE_LABEL[o.stage]}</span>` : `<span class="pill ${o.status}">${L.STATUS_LABEL[o.status]}</span>`}
      ${L.isOverdue(o, today) ? '<span class="pill over">已過保留期限</span>' : ''}
      <span class="mono">${esc(o.orderNo)}</span>${active && o.holdUntil ? `<span>保留至 ${esc(o.holdUntil)}</span>` : ''}</span></button>`;
}

function renderList() {
  if (!$('#list')) return;
  const today = L.twNow().date, q = S.q.trim().toLowerCase();
  const count = f => S.open.filter(f).length;
  const filters = [['all', '全部', () => true], ['ordered', '待到貨', o => o.stage === 'ordered'], ['arrived', '已到貨 待通知', o => o.stage === 'arrived'],
    ['notified', '已通知 待取貨', o => o.stage === 'notified'], ['over', '已過期限', o => L.isOverdue(o, today)]];
  $('#chips').innerHTML = filters.map(f => `<button class="opt sm${S.filter === f[0] ? ' on' : ''}" data-act="filter" data-v="${f[0]}">${f[1]} ${count(f[2])}</button>`).join('');
  $('#openSum').textContent = `未取貨 ${S.open.length} 筆，預收訂金合計 ${money(S.open.reduce((a, o) => a + o.held, 0))}`;
  const pass = filters.find(f => f[0] === S.filter)[2];
  const rows = S.open.filter(o => pass(o) && (!q || [o.orderNo, o.customer, o.phone, o.itemsText].join(' ').toLowerCase().includes(q)));
  $('#list').innerHTML = rows.map(o => orderCard(o, today)).join('') ||
    `<div class="empty">${S.open.length ? '沒有符合的未取貨訂金單' : '目前沒有未取貨的訂金單'}</div>`;
  const openNos = new Set(S.open.map(o => o.orderNo));
  $('#hist').innerHTML = !q ? '' : S.history && S.history.q === q
    ? `<h3 style="margin-top:18px">已結案的單</h3>` + (S.history.rows.filter(o => !openNos.has(o.orderNo)).map(o => orderCard(o, today)).join('') ||
      '<div class="empty">找不到。已結案的單請輸入完整的電話、電話末 3～4 碼、完整姓名、單號或發票號碼。</div>')
    : `<button class="btn" style="width:100%" data-act="history">也搜尋已結案的單</button>`;
}

/* ---------- 收訂金／修改資料 ---------- */

function itemRow(it = {}) {
  return `<div class="item"><input class="nm" placeholder="品名" value="${esc(it.name)}" aria-label="品名">
    <input class="sp" placeholder="尺寸／顏色" value="${esc(it.spec)}" aria-label="尺寸顏色">
    <input class="qt" type="number" inputmode="numeric" min="1" placeholder="數量" value="${esc(it.qty || 1)}" aria-label="數量">
    <input class="pr" type="number" inputmode="numeric" min="0" placeholder="單價" value="${it.price ? esc(it.price) : ''}" aria-label="單價">
    <button type="button" data-act="delItem" aria-label="移除這一項">✕</button></div>`;
}
const readItems = () => $$('#items .item').map(r => ({ name: $('.nm', r).value, spec: $('.sp', r).value, qty: $('.qt', r).value, price: $('.pr', r).value }));

function renderForm(edit) {
  S.edit = edit || null;
  const o = edit || {}, today = L.twNow().date;
  const hold = edit ? o.holdUntil : (S.settings.holdDays ? L.addDays(today, S.settings.holdDays) : '');
  $('#view').innerHTML = `<div class="row" style="margin-bottom:10px"><button class="btn ghost" data-act="${edit ? 'backDetail' : 'home'}">← 返回</button>
      <h2 style="margin:0">${edit ? `修改資料 <span class="mono">${esc(o.orderNo)}</span>` : '收訂金'}</h2></div><div id="formErr"></div>
    <div class="card"><h3>① 客戶</h3><div class="grid2">
      ${field('電話', `<input id="fPhone" inputmode="tel" autocomplete="off" value="${esc(o.phone)}">`, '老客戶會自動帶出姓名')}
      ${field('姓名', `<input id="fName" autocomplete="off" value="${esc(o.customer)}">`)}</div></div>
    <div class="card"><h3>② 商品</h3><div id="items">${(o.items || [{}]).map(itemRow).join('')}</div>
      <div class="row"><button class="btn" data-act="addItem">＋ 再加一項</button><span style="margin-left:auto">商品總價 <b class="num" id="fTotal" style="font-size:20px">$0</b></span></div>
      <p class="mute" style="margin:8px 0 0">價格還沒確定可以先留空，取貨結帳時再填。</p></div>
    ${edit ? '' : `<div class="card"><h3>③ 訂金</h3>
      ${field('訂金金額', '<input id="fAmt" type="number" inputmode="numeric" min="1">')}
      <div class="opts"><button type="button" class="opt sm" data-act="quick" data-v="1">付全額</button><button type="button" class="opt sm" data-act="quick" data-v="0.5">付一半</button></div>
      ${payFields()}${inv() ? field('訂金發票號碼', '<input id="fInv" autocomplete="off" maxlength="20">', '選填') : ''}</div>`}
    <details class="card"${edit ? ' open' : ''}><summary style="font-weight:700;cursor:pointer">其他資料（選填）</summary><div style="margin-top:12px">
      <label class="f" style="margin-bottom:4px"><span>來源</span></label>${options('source', S.settings.sources, o.source)}
      <div class="grid2">${field('預計到貨日', `<input id="fExp" type="date" value="${esc(o.expectedDate)}">`)}
      ${field('保留期限', `<input id="fHold" type="date" value="${esc(hold)}">`)}</div>
      ${field('備註', `<textarea id="fNote">${esc(o.note)}</textarea>`)}</div></details>
    <div class="bar"><div><div class="sum" id="fSum"></div><button class="btn pri" data-act="submitForm">${edit ? '儲存修改' : '建立訂金單'}</button></div></div>`;
  updateFormSum();
  if (!edit) $('#fPhone').focus();
}

function updateFormSum() {
  if (!$('#fTotal')) return;
  const total = readItems().reduce((a, it) => a + (Number(it.qty) || 0) * (Number(it.price) || 0), 0);
  $('#fTotal').textContent = money(total);
  if (S.edit) { $('#fSum').innerHTML = `商品總價 <b class="num">${money(total)}</b>`; return; }
  const amt = Number($('#fAmt').value) || 0;
  $('#fSum').innerHTML = `訂金 <b class="num">${money(amt)}</b>` + (total ? `<br>取貨時再收 <span class="num">${money(Math.max(total - amt, 0))}</span>` : '');
}

function readForm() {
  return { customer: $('#fName').value, phone: $('#fPhone').value, items: readItems(), source: picked($('#view'), 'source'),
    expectedDate: $('#fExp').value, holdUntil: $('#fHold').value, note: $('#fNote').value };
}

function renderDone(order) {
  S.cur = { order, txs: [] };
  $('#view').innerHTML = `<div class="card" style="text-align:center"><div class="pill closed" style="font-size:15px">訂金單已建立</div>
      <div class="done-no mono">${esc(order.orderNo)}</div>
      <p>${esc(order.customer)}　已收訂金 <b class="num">${money(order.deposit)}</b>${order.totalPrice ? `<br>取貨時再收 <b class="num">${money(order.totalPrice - order.held)}</b>` : ''}</p>
      <button class="btn pri big" data-act="print">列印收據</button>
      <div class="row" style="margin-top:10px"><button class="btn" style="flex:1" data-act="new">再收一筆</button><button class="btn" style="flex:1" data-act="home">回首頁</button></div></div>`;
}

/* ---------- 訂金單明細 ---------- */

async function openDetail(orderNo) {
  try { go('detail', await S.ops.getOrder(orderNo)); } catch (e) { toast(e.message, true); }
}

function txTable(txs, withOrder) {
  if (!txs.length) return '<div class="empty">沒有收付紀錄</div>';
  return `<div class="scroll"><table><tr><th>${withOrder ? '時間／單號' : '收據編號'}</th><th>類型</th><th>方式</th><th class="r">金額</th><th>經手人</th></tr>${txs.map(x =>
    `<tr class="${x.voided ? 'voided' : ''}"><td>${withOrder ? `${esc(x.time.slice(5, 16))}<br><span class="mono mute">${esc(x.orderNo)}</span> ${esc(x.customer)}` : `<span class="mono">${esc(x.txId)}</span><br><span class="mute">${esc(x.time.slice(0, 16))}</span>`}</td>
      <td>${L.TYPE_LABEL[x.type]}</td><td>${esc(x.method)}${x.payDate ? `<br><span class="mute">入金 ${esc(x.payDate)}${x.ref ? '／' + esc(x.ref) : ''}</span>` : ''}</td>
      <td class="r num">${x.type === 'refund' ? '−' : ''}${money(x.amount)}</td><td>${esc(x.staff)}</td></tr>`).join('')}</table></div>`;
}

function renderDetail(v) {
  S.cur = v;
  const o = v.order, active = o.status === 'active', mgr = S.user.role === 'manager', sell = canSell();
  const stageIdx = active ? ['ordered', 'arrived', 'notified'].indexOf(o.stage) : (o.status === 'closed' ? 3 : -1);
  const steps = ['已收訂金', '已到貨', '已通知客戶', '已取貨'].map((s, i) => `<div class="${i <= stageIdx ? 'done' : ''}">${s}</div>`).join('');
  const box = (label, val, hl) => `<div class="${hl ? 'hl' : ''}"><span class="mute">${label}</span><b class="num">${val}</b></div>`;
  const moneyRow = active
    ? box('商品總價', o.totalPrice ? money(o.totalPrice) : '未定') + box('已收訂金', money(o.held)) + box('取貨時再收', o.totalPrice ? money(o.totalPrice - o.held) : '未定', true)
    : o.status === 'closed' ? box('商品總價', money(o.totalPrice)) + box('訂金折抵', money(o.applied)) + box('尾款', money(o.tail))
      : box('已收訂金', money(o.deposit)) + box('已退還', money(o.refunded)) + box('沒收', money(o.forfeited));
  const next = { ordered: ['arrived', '商品到貨了'], arrived: ['notified', '已通知客戶來取貨'] }[o.stage];
  const prev = { arrived: ['ordered', '待到貨'], notified: ['arrived', '已到貨'] }[o.stage];
  const dd = (k, val) => (val ? `<dt>${k}</dt><dd>${val}</dd>` : '');
  $('#view').innerHTML = `<div class="row" style="margin-bottom:10px"><button class="btn ghost" data-act="back">← 返回</button></div>
    <div class="card"><div class="row"><span class="mono" style="font-size:24px;font-weight:800;flex:1">${esc(o.orderNo)}</span>
        <span class="pill ${active ? o.stage : o.status}" style="font-size:15px">${active ? L.STAGE_LABEL[o.stage] : L.STATUS_LABEL[o.status]}</span></div>
      <div style="font-size:18px;font-weight:700;margin-top:6px">${esc(o.customer)} <span class="mute num">${esc(o.phone)}</span></div>
      ${o.status === 'closed' || active ? `<div class="steps">${steps}</div>` : ''}<div class="money">${moneyRow}</div>
      ${active && sell ? `${next ? `<button class="btn pri big" data-act="stage" data-v="${next[0]}">${next[1]}</button>` : ''}
        <button class="btn ${next ? '' : 'pri '}big" style="margin-top:10px" data-act="mClose">客戶取貨結帳</button>` : ''}
      <div class="row" style="margin-top:12px">${active && sell ? '<button class="btn" data-act="mPay">追加訂金</button><button class="btn" data-act="edit">修改資料</button>' : ''}
        <button class="btn" data-act="print">列印收據</button>
        ${active && sell && prev ? `<button class="btn ghost" data-act="stage" data-v="${prev[0]}">改回「${prev[1]}」</button>` : ''}</div>
      ${canPost() ? `<div class="row" style="margin-top:12px;padding-top:12px;border-top:1px dashed var(--line)"><span class="mute">${mgr ? '經理功能' : '會計功能'}</span>
        ${mgr && active ? '<button class="btn danger" data-act="mCancel">退訂</button>' : ''}
        ${mgr && o.status !== 'void' ? '<button class="btn danger" data-act="mVoid">作廢</button>' : ''}
        <button class="btn" data-act="posted">${o.posted ? '✓ 會計已轉記（點此取消）' : '標記為會計已轉記'}</button></div>` : (o.posted ? '<p class="mute" style="margin:10px 0 0">✓ 會計已轉記</p>' : '')}</div>
    <div class="card"><h3>商品</h3><div class="scroll"><table><tr><th>品名</th><th>尺寸／顏色</th><th class="r">數量</th><th class="r">單價</th><th class="r">小計</th></tr>${o.items.map(it =>
      `<tr><td class="w">${esc(it.name)}</td><td>${esc(it.spec)}</td><td class="r num">${it.qty}</td><td class="r num">${it.price ? money(it.price) : '未定'}</td><td class="r num">${it.price ? money(it.qty * it.price) : ''}</td></tr>`).join('')}</table></div></div>
    <div class="card"><h3>資料</h3><dl>${dd('來源', esc(o.source))}${dd('預計到貨', esc(o.expectedDate))}${dd('保留期限', esc(o.holdUntil) + (L.isOverdue(o, L.twNow().date) ? ' <span class="pill over">已過期限</span>' : ''))}
      ${dd('到貨日', esc(o.arrivedAt))}${dd('通知日', esc(o.notifiedAt))}${dd('結案', o.closedAt ? `${esc(o.closedAt.slice(0, 16))}　${esc(o.closedBy)}` : '')}
      ${dd('支付方式', esc(o.payMethods))}${dd('訂金發票', esc(o.depositInvoice))}${dd('結帳發票', esc(o.finalInvoice))}${dd('舊帳本 No.', esc(o.legacyNo))}${dd('備註', esc(o.note))}
      ${dd('建立', `${esc(o.createdAt.slice(0, 16))}　${esc(o.createdBy)}`)}</dl></div>
    <div class="card"><h3>收付紀錄</h3>${txTable(v.txs)}</div>`;
}

const MODALS = {
  mPay() {
    openModal(`<h2>追加訂金</h2>${field('金額', '<input id="mAmt" type="number" inputmode="numeric" min="1">')}${payFields()}
      ${inv() ? field('發票號碼', '<input id="mInv" maxlength="20">', '選填') : ''}
      <button class="btn pri big" data-act="doPay">確認收款</button><button class="btn ghost" style="width:100%" data-act="closeModal">取消</button>`);
  },
  mClose() {
    const o = S.cur.order;
    openModal(`<h2>客戶取貨結帳</h2>
      ${field('商品總價', `<input id="mTotal" type="number" inputmode="numeric" min="1" value="${o.totalPrice || ''}">`, o.totalPrice ? '有變動可直接修改' : '請輸入最後的總價')}
      <div class="money" style="grid-template-columns:1fr 1fr"><div><span class="mute">訂金折抵</span><b class="num">−${money(o.held)}</b></div>
        <div class="hl"><span class="mute">這次要收的尾款</span><b class="num" id="mTail"></b></div></div>
      <div id="mTailPay">${payFields()}</div>${inv() ? field('結帳發票號碼', '<input id="mInv" maxlength="20">', '選填') : ''}
      <button class="btn pri big" data-act="doClose">確認結帳</button><button class="btn ghost" style="width:100%" data-act="closeModal">取消</button>`);
    updateTail();
  },
  mCancel() {
    const o = S.cur.order, last = [...S.cur.txs].reverse().find(x => x.type === 'deposit');
    openModal(`<h2>退訂</h2><p>已收訂金 <b class="num">${money(o.held)}</b>。沒有退還的部分會列為沒收。</p>
      ${field('退還給客戶的金額', `<input id="mRefund" type="number" inputmode="numeric" min="0" value="${o.held}">`)}
      <p class="mute">沒收金額：<b class="num" id="mForfeit">$0</b></p>${payFields(last ? last.method : '')}
      ${field('退訂原因', '<input id="mReason" maxlength="200">')}
      <button class="btn pri big" data-act="doCancel">確認退訂</button><button class="btn ghost" style="width:100%" data-act="closeModal">取消</button>`);
  },
  mVoid() {
    openModal(`<h2>作廢這張單</h2><p>作廢只用在<b>登打錯誤</b>。這張單的收付紀錄會保留但不計入報表，單號不會再使用。客戶取消訂單請改用「退訂」。</p>
      ${field('作廢原因', '<input id="mReason" maxlength="200">')}
      <button class="btn danger big" data-act="doVoid">確認作廢</button><button class="btn ghost" style="width:100%" data-act="closeModal">取消</button>`);
  }
};

function updateTail() {
  if (!$('#mTail')) return;
  const tail = (Number($('#mTotal').value) || 0) - S.cur.order.held;
  $('#mTail').textContent = tail < 0 ? '總價低於訂金' : money(tail);
  $('#mTailPay').classList.toggle('hide', tail <= 0);
}

function printReceipt() {
  const o = S.cur.order, s = S.settings;
  const paid = o.status === 'closed' ? o.applied + o.tail : o.held;
  $('#receipt').innerHTML = `<h2>${esc(s.shopName)}　${o.status === 'closed' ? '結帳收據' : '訂金收據'}</h2><div class="no mono">${esc(o.orderNo)}</div>
    <table><tr><th>日期</th><td>${esc(o.createdAt.slice(0, 10))}</td><th>經手人</th><td>${esc(o.createdBy)}</td></tr>
      <tr><th>客戶</th><td>${esc(o.customer)}</td><th>電話</th><td>${esc(o.phone)}</td></tr></table>
    <table style="margin-top:3mm"><tr><th>品名</th><th>尺寸／顏色</th><th class="r">數量</th><th class="r">單價</th></tr>${o.items.map(it =>
      `<tr><td class="w">${esc(it.name)}</td><td>${esc(it.spec)}</td><td class="r">${it.qty}</td><td class="r">${it.price ? money(it.price) : '未定'}</td></tr>`).join('')}</table>
    <table style="margin-top:3mm"><tr><th>商品總價（含稅）</th><td class="r">${o.totalPrice ? money(o.totalPrice) : '未定'}</td></tr>
      <tr><th>已收金額</th><td class="r"><b>${money(paid)}</b></td></tr>
      ${o.status === 'active' && o.totalPrice ? `<tr><th>取貨時應付</th><td class="r">${money(o.totalPrice - o.held)}</td></tr>` : ''}
      ${o.status === 'active' && o.holdUntil ? `<tr><th>保留期限</th><td class="r">${esc(o.holdUntil)}</td></tr>` : ''}</table>
    <p>${esc(s.terms)}</p><div class="sign"><span>店章：</span><span>客戶簽名：＿＿＿＿＿＿＿＿＿</span></div>`;
  window.print();
}

/* ---------- 報表 ---------- */

function renderReport() {
  const today = L.twNow().date;
  $('#view').innerHTML = `<div class="card"><h2>報表</h2>
      <div class="opts">${[['today', '今天'], ['yesterday', '昨天'], ['month', '本月'], ['lastMonth', '上月']].map(r => `<button class="opt sm" data-act="range" data-v="${r[0]}">${r[1]}</button>`).join('')}</div>
      <div class="grid2">${field('開始', `<input id="rFrom" type="date" value="${today}">`)}${field('結束', `<input id="rTo" type="date" value="${today}">`)}</div>
      <button class="btn pri" data-act="report">查詢</button></div><div id="rOut"></div>
    ${canPost() ? `<div class="card"><h3>匯出備份</h3><p class="mute">下載全部資料，可用 Excel 開啟。建議每週一次，存到雲端硬碟。</p>
      <button class="btn" data-act="export">下載訂金單與收付明細</button></div>` : ''}`;
  loadReport();
}

async function loadReport(btn) {
  const from = $('#rFrom').value, to = $('#rTo').value;
  if (!from || !to || from > to) return toast('請確認開始與結束日期', true);
  const job = async () => {
    const r = await S.ops.report(from, to), t = r.totals;
    const cash = r.methods.find(m => m.method === '現金');
    $('#rOut').innerHTML = `<div class="card"><h3>${from === to ? esc(from) + ' 日結' : `${esc(from)} ～ ${esc(to)}`}</h3>
        <div class="money"><div><span class="mute">實收（訂金＋尾款）</span><b class="num">${money(t.inAmt)}</b></div>
          <div><span class="mute">退款</span><b class="num">${money(t.outAmt)}</b></div><div class="hl"><span class="mute">淨收</span><b class="num">${money(t.net)}</b></div></div>
        ${cash ? `<p>現金應增加 <b class="num" style="font-size:19px">${money(cash.inAmt - cash.outAmt)}</b> <span class="mute">（請與錢櫃核對）</span></p>` : ''}
        <div class="scroll"><table><tr><th>支付方式</th><th class="r">筆數</th><th class="r">收款</th><th class="r">退款</th><th class="r">淨額</th></tr>${r.methods.map(m =>
          `<tr><td>${esc(m.method)}</td><td class="r num">${m.count}</td><td class="r num">${money(m.inAmt)}</td><td class="r num">${money(m.outAmt)}</td><td class="r num"><b>${money(m.inAmt - m.outAmt)}</b></td></tr>`).join('') || '<tr><td colspan="5" class="mute">這段期間沒有收付款</td></tr>'}</table></div>
        <dl style="margin-top:14px"><dt>訂金收款</dt><dd class="num">${money(t.deposit)}</dd><dt>尾款收款</dt><dd class="num">${money(t.tail)}</dd>
          <dt>沒收訂金</dt><dd class="num">${money(t.forfeit)}</dd><dt>淨收未稅／稅額</dt><dd class="num">${money(t.netExTax)}／${money(t.tax)}</dd>
          ${t.voided ? `<dt>已作廢</dt><dd>${t.voided} 筆（未計入）</dd>` : ''}
          <dt>目前未取貨</dt><dd class="num">${S.open.length} 筆，預收訂金 ${money(S.open.reduce((a, o) => a + o.held, 0))}</dd></dl></div>
      <div class="card"><h3>收付明細</h3>${txTable(r.txs, true)}</div>`;
  };
  if (btn) await run(btn, job); else await job().catch(e => toast(e.message, true));
}

const ORDER_COLS = [['orderNo', '單號'], [o => L.STATUS_LABEL[o.status], '狀態'], [o => (o.status === 'active' ? L.STAGE_LABEL[o.stage] : ''), '階段'], ['createdAt', '建立時間'],
  ['customer', '客戶'], ['phone', '電話'], ['source', '來源'], ['itemsText', '商品'], ['totalPrice', '商品總價'], ['deposit', '已收訂金'], ['tail', '尾款'],
  ['refunded', '已退款'], ['forfeited', '已沒收'], ['held', '未結訂金'], ['payMethods', '支付方式'], ['expectedDate', '預計到貨'], ['holdUntil', '保留期限'], ['arrivedAt', '到貨日'],
  ['notifiedAt', '通知日'], ['closedAt', '結案時間'], ['closedBy', '結案人員'], ['depositInvoice', '訂金發票'], ['finalInvoice', '結帳發票'], ['legacyNo', '舊帳本No'],
  [o => (o.posted ? '是' : ''), '已轉記'], ['createdBy', '建立人'], ['note', '備註']];
const TX_COLS = [['txId', '收據編號'], ['orderNo', '單號'], ['customer', '客戶'], ['time', '時間'], ['bizDate', '營業日'], [x => L.TYPE_LABEL[x.type], '類型'], ['method', '支付方式'],
  ['amount', '金額(含稅)'], ['net', '未稅'], ['tax', '稅額'], ['payDate', '入金日'], ['ref', '參考號'], ['invoiceNo', '發票號碼'], ['staff', '經手人'], ['note', '備註'], [x => (x.voided ? '是' : ''), '作廢']];

/* ---------- 設定（經理） ---------- */

async function renderSettings() {
  const s = S.settings;
  $('#view').innerHTML = `<div id="formErr"></div><div class="card"><h2>人員</h2><div id="staffList" class="mute">載入中…</div>
      <h3 style="margin-top:16px">新增人員</h3><div class="grid2">${field('姓名', '<input id="sName">')}${field('Email', '<input id="sEmail" type="email" autocomplete="off">', '登入用')}
      ${field('密碼', '<input id="sPass" type="text" autocomplete="off">', '至少 6 個字')}${field('角色', '<select id="sRole"><option value="staff">店員</option><option value="accountant">會計（只能查看、轉記、匯出）</option><option value="manager">經理</option></select>')}</div>
      <button class="btn pri" data-act="addStaff">新增</button></div>
    <div class="card"><h2>店鋪設定</h2>${field('店名', `<input id="cShop" value="${esc(s.shopName)}">`)}
      ${field('支付方式', `<input id="cMethods" value="${esc(s.methods.join('、'))}">`, '用「、」分隔；名稱含「轉帳」會多問入金日')}
      ${field('來源', `<input id="cSources" value="${esc(s.sources.join('、'))}">`, '用「、」分隔')}
      ${field('預設保留天數', `<input id="cHold" type="number" min="0" value="${esc(s.holdDays)}">`, '0 表示不預設')}
      ${field('是否另外開立發票', `<select id="cInv"><option value="1"${inv() ? ' selected' : ''}>是，顯示發票號碼欄位</option><option value="0"${inv() ? '' : ' selected'}>否，只用本系統的收據</option></select>`)}
      ${field('收據條款', `<textarea id="cTerms">${esc(s.terms)}</textarea>`)}<button class="btn pri" data-act="saveSettings">儲存設定</button></div>
    <div class="card"><h2>資料檢查</h2><p class="mute">用收付明細重新加總每張單，確認金額一致。</p><button class="btn" data-act="integrity">開始檢查</button><div id="chkOut" style="margin-top:10px"></div></div>`;
  try {
    const rows = await S.ops.listStaff();
    $('#staffList').className = 'scroll';
    $('#staffList').innerHTML = `<table><tr><th>姓名</th><th>Email</th><th>角色</th><th>狀態</th><th></th></tr>${rows.map(r => `<tr><td>${esc(r.name)}</td><td>${esc(r.email)}</td><td>${L.ROLE_LABEL[r.role]}</td>
      <td>${r.active ? '<span class="pill closed">啟用</span>' : '<span class="pill void">停用</span>'}</td>
      <td>${r.uid === S.user.uid ? '' : `<button class="btn" data-act="toggleStaff" data-uid="${esc(r.uid)}">${r.active ? '停用' : '啟用'}</button>`}</td></tr>`).join('')}</table>`;
    S.staff = rows;
  } catch (e) { showErr(e); }
}

/* ---------- 動作 ---------- */

/* ---------- 總表（接近 Excel 帳本的排版） ---------- */

const statusText = o => (o.status === 'active' ? L.STAGE_LABEL[o.stage] : L.STATUS_LABEL[o.status]);
// [標題, 取值, 是否為數字, 是否只在開立發票時顯示]
const SHEET_COLS = [
  ['單號', o => o.orderNo], ['受注日', o => o.bizDate], ['客戶姓名', o => o.customer], ['電話', o => o.phone],
  ['商品內容', o => o.itemsText], ['商品總價', o => o.totalPrice, true], ['受注人員', o => o.createdBy], ['支付方式', o => o.payMethods || ''],
  ['訂金', o => o.deposit, true], ['訂金發票', o => o.depositInvoice, false, true], ['到貨日', o => o.arrivedAt], ['狀況', statusText],
  ['結案日', o => o.closedAt.slice(0, 10)], ['結案人員', o => o.closedBy], ['尾款', o => o.tail, true], ['退款', o => o.refunded, true],
  ['沒收', o => o.forfeited, true], ['未結訂金', o => o.held, true], ['結帳發票', o => o.finalInvoice, false, true], ['備註', o => o.note]
];
const sheetCols = () => SHEET_COLS.filter(c => !c[3] || inv());

function renderTable() {
  const t = S.table, today = L.twNow().date;
  if (!t.from) { t.from = today.slice(0, 8) + '01'; t.to = today; }
  $('#view').innerHTML = `<div class="card"><div class="row" style="align-items:flex-end">
      <label class="f" style="margin:0"><span>狀態</span><select id="tStatus" style="width:auto">${[['all', '全部'], ['open', '未取貨（不限日期）'], ['closed', '已取貨'], ['refunded', '已退訂'], ['void', '已作廢'], ['unposted', '會計未轉記']]
        .map(s => `<option value="${s[0]}"${t.status === s[0] ? ' selected' : ''}>${s[1]}</option>`).join('')}</select></label>
      <label class="f" style="margin:0"><span>受注日 從</span><input id="tFrom" type="date" value="${t.from}" style="width:auto"></label>
      <label class="f" style="margin:0"><span>到</span><input id="tTo" type="date" value="${t.to}" style="width:auto"></label>
      <button class="btn pri" data-act="tableLoad">查詢</button>
      <div class="opts" style="margin:0">${[['month', '本月'], ['lastMonth', '上月'], ['year', '今年']].map(r => `<button class="opt sm" data-act="tableRange" data-v="${r[0]}">${r[1]}</button>`).join('')}</div>
      <input id="tq" type="search" placeholder="在結果中篩選：姓名、電話、商品、單號、發票" value="${esc(t.q)}" style="flex:1;min-width:220px" aria-label="在結果中篩選">
      <button class="btn" data-act="tableCsv">下載這份表</button></div></div>
    <div id="sheetSum"></div><div class="sheet" id="sheet"><div class="empty">載入中…</div></div>`;
  loadTable();
}

async function loadTable(btn) {
  const t = S.table;
  t.status = $('#tStatus').value; t.from = $('#tFrom').value; t.to = $('#tTo').value;
  if (t.status !== 'open' && (!t.from || !t.to || t.from > t.to)) return toast('請確認開始與結束日期', true);
  const job = async () => { t.rows = t.status === 'open' ? null : await S.ops.listOrders(t.from, t.to); renderSheet(); };
  if (btn) await run(btn, job); else await job().catch(e => toast(e.message, true));
}

function sheetRows() {
  const t = S.table, q = t.q.trim().toLowerCase(), cols = sheetCols();
  let rows = t.status === 'open' ? S.open : (t.rows || []);
  if (t.status === 'unposted') rows = rows.filter(o => !o.posted && o.status !== 'void');
  else if (t.status !== 'all' && t.status !== 'open') rows = rows.filter(o => o.status === t.status);
  if (q) rows = rows.filter(o => cols.map(c => c[1](o)).join(' ').toLowerCase().includes(q));
  const col = cols.find(c => c[0] === t.sort) || cols[0];
  return [...rows].sort((a, b) => { const x = col[1](a), y = col[1](b); return (x < y ? -1 : x > y ? 1 : 0) * (t.desc ? -1 : 1); });
}

function renderSheet() {
  if (!$('#sheet')) return;
  const t = S.table, cols = sheetCols(), rows = sheetRows(), sum = L.ledgerTotals(rows);
  $('#sheetSum').innerHTML = `<div class="money" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
    <div><span class="mute">筆數（不含作廢）</span><b class="num">${sum.count}</b></div><div><span class="mute">訂金總計</span><b class="num">${money(sum.deposit)}</b></div>
    <div><span class="mute">已結帳折抵</span><b class="num">${money(sum.settled)}</b></div><div><span class="mute">退訂（退款＋沒收）</span><b class="num">${money(sum.cancelled)}</b></div>
    <div class="hl"><span class="mute">未結訂金</span><b class="num">${money(sum.open)}</b></div></div>`;
  $('#sheet').innerHTML = rows.length ? `<table><thead><tr><th>轉記</th>${cols.map(c =>
      `<th class="${c[2] ? 'r' : ''}"><button data-act="tableSort" data-v="${c[0]}">${c[0]}${t.sort === c[0] ? (t.desc ? ' ▼' : ' ▲') : ''}</button></th>`).join('')}</tr></thead><tbody>${rows.map(o =>
      `<tr class="${o.status === 'void' ? 'voided' : ''}" data-no="${esc(o.orderNo)}"><td class="c">${canPost()
        ? `<input type="checkbox" data-post="${esc(o.orderNo)}"${o.posted ? ' checked' : ''} aria-label="會計已轉記">` : (o.posted ? '✓' : '')}</td>${cols.map((c, i) => {
        const v = c[1](o);
        return `<td class="${c[2] ? 'r num' : ''}${i === 0 ? ' mono' : ''}">${c[2] ? (v ? money(v) : '') : esc(v)}</td>`;
      }).join('')}</tr>`).join('')}</tbody></table>` : '<div class="empty">這個條件下沒有訂金單</div>';
}

const reload = async order => go('detail', await S.ops.getOrder(order.orderNo));

const ACT = {
  tab: el => go(el.dataset.v),
  home: () => go('home'),
  back: () => go(S.back),
  new: () => go('form'),
  logout: () => S.auth.signOut(),
  closeModal,
  demoLogin: el => run(el, () => S.auth.signIn(el.dataset.email)),
  pickAccount: el => { $('#lgEmail').value = el.dataset.email; $('#lgPass').focus(); },
  login: el => run(el, () => S.auth.signIn($('#lgEmail').value.trim(), $('#lgPass').value)),
  forgot: el => run(el, async () => {
    const email = $('#lgEmail').value.trim();
    if (!email) throw new Error('請先輸入 Email');
    await S.auth.resetPassword(email); toast('已寄出重設密碼的信');
  }),
  init: el => run(el, async () => {
    const name = L.cleanText($('#inName').value, 30);
    if (!name) throw new Error('請輸入您的姓名');
    const uid = el.dataset.uid, shopName = L.cleanText($('#inShop').value, 40) || L.DEFAULT_SETTINGS.shopName;
    await S.store.tx(async t => {
      if (await t.get('settings', 'main')) throw new Error('系統已經初始化，請聯絡經理開通帳號');
      t.set('staff', uid, { uid, name, email: el.dataset.email, role: 'manager', active: true });
      t.set('settings', 'main', { ...L.DEFAULT_SETTINGS, shopName });
    });
    await onAuth({ uid, email: el.dataset.email });
  }),

  tableLoad: el => loadTable(el),
  tableRange: el => {
    const today = L.twNow().date, first = today.slice(0, 8) + '01', lastPrev = L.addDays(first, -1);
    const [from, to] = { month: [first, today], lastMonth: [lastPrev.slice(0, 8) + '01', lastPrev], year: [today.slice(0, 5) + '01-01', today] }[el.dataset.v];
    $('#tFrom').value = from; $('#tTo').value = to; loadTable();
  },
  tableSort: el => { const t = S.table; if (t.sort === el.dataset.v) t.desc = !t.desc; else { t.sort = el.dataset.v; t.desc = false; } renderSheet(); },
  tableCsv: () => { download(`訂金總表_${L.twNow().date}.csv`, L.toCsv(sheetRows(), ORDER_COLS)); toast('已下載'); },
  filter: el => { S.filter = el.dataset.v; renderList(); },
  open: el => openDetail(el.dataset.no),
  history: el => run(el, async () => { const q = S.q.trim().toLowerCase(); S.history = { q, rows: await S.ops.search(q) }; renderList(); }),

  addItem: () => { $('#items').insertAdjacentHTML('beforeend', itemRow()); $('#items .item:last-child .nm').focus(); },
  delItem: el => { if ($$('#items .item').length > 1) el.closest('.item').remove(); else $$('input', el.closest('.item')).forEach(i => { i.value = i.classList.contains('qt') ? 1 : ''; }); updateFormSum(); },
  quick: el => {
    const total = readItems().reduce((a, it) => a + (Number(it.qty) || 0) * (Number(it.price) || 0), 0);
    if (!total) return toast('請先輸入商品單價', true);
    $('#fAmt').value = Math.round(total * Number(el.dataset.v)); updateFormSum();
  },
  submitForm: el => run(el, async () => {
    if (S.edit) { const o = await S.ops.updateOrder(S.edit.orderNo, readForm()); toast('已儲存'); return reload(o); }
    const card = $('#fAmt').closest('.card');
    const order = await S.ops.createOrder({ ...readForm(), payment: { ...readPay(card), amount: $('#fAmt').value, invoiceNo: $('#fInv') ? $('#fInv').value : '' } });
    go('done', order);
  }),
  edit: () => go('form', S.cur.order),
  backDetail: () => go('detail', S.cur),

  stage: el => run(el, async () => { const o = await S.ops.setStage(S.cur.order.orderNo, el.dataset.v); toast(`已更新為「${L.STAGE_LABEL[o.stage]}」`); return reload(o); }),
  mPay: () => MODALS.mPay(), mClose: () => MODALS.mClose(), mCancel: () => MODALS.mCancel(), mVoid: () => MODALS.mVoid(),
  doPay: el => run(el, async () => {
    const o = await S.ops.addDeposit(S.cur.order.orderNo, { ...readPay($('#modalBody')), amount: $('#mAmt').value, invoiceNo: $('#mInv') ? $('#mInv').value : '' });
    closeModal(); toast('已收款'); return reload(o);
  }),
  doClose: el => run(el, async () => {
    const o = await S.ops.closeOrder(S.cur.order.orderNo, { ...readPay($('#modalBody')), totalPrice: $('#mTotal').value, invoiceNo: $('#mInv') ? $('#mInv').value : '' });
    closeModal(); toast('結帳完成'); return reload(o);
  }),
  doCancel: el => run(el, async () => {
    const o = await S.ops.cancelOrder(S.cur.order.orderNo, { ...readPay($('#modalBody')), refundAmount: $('#mRefund').value, reason: $('#mReason').value });
    closeModal(); toast('已退訂'); return reload(o);
  }),
  doVoid: el => run(el, async () => { const o = await S.ops.voidOrder(S.cur.order.orderNo, { reason: $('#mReason').value }); closeModal(); toast('已作廢'); return reload(o); }),
  posted: el => run(el, async () => reload(await S.ops.setPosted(S.cur.order.orderNo, !S.cur.order.posted))),
  print: async () => { if (!S.cur.txs.length) S.cur = await S.ops.getOrder(S.cur.order.orderNo); printReceipt(); },

  range: el => {
    const today = L.twNow().date, first = today.slice(0, 8) + '01', lastPrev = L.addDays(first, -1);
    const [from, to] = { today: [today, today], yesterday: [L.addDays(today, -1), L.addDays(today, -1)], month: [first, today],
      lastMonth: [lastPrev.slice(0, 8) + '01', lastPrev] }[el.dataset.v];
    $('#rFrom').value = from; $('#rTo').value = to; loadReport();
  },
  report: el => loadReport(el),
  export: el => run(el, async () => {
    const { orders, txs } = await S.ops.exportAll(), d = L.twNow().date;
    download(`訂金單_${d}.csv`, L.toCsv(orders, ORDER_COLS));
    download(`收付明細_${d}.csv`, L.toCsv(txs, TX_COLS));
    toast('已下載 2 個檔案');
  }),

  addStaff: el => run(el, async () => {
    const name = L.cleanText($('#sName').value, 30), email = $('#sEmail').value.trim(), pass = $('#sPass').value;
    if (!name || !email) throw new Error('請輸入姓名與 Email');
    if (pass.length < 6) throw new Error('密碼至少要 6 個字');
    const uid = await S.auth.createUser(email, pass);
    await S.ops.saveStaff(uid, { name, email, role: $('#sRole').value, active: true });
    toast(`已新增 ${name}`); renderSettings();
  }),
  toggleStaff: el => run(el, async () => {
    const r = S.staff.find(x => x.uid === el.dataset.uid);
    await S.ops.saveStaff(r.uid, { ...r, active: !r.active }); renderSettings();
  }),
  saveSettings: el => run(el, async () => {
    S.settings = await S.ops.saveSettings({ shopName: $('#cShop').value, methods: $('#cMethods').value, sources: $('#cSources').value, holdDays: $('#cHold').value, terms: $('#cTerms').value, useInvoice: $('#cInv').value === '1' });
    $('#shop').textContent = S.settings.shopName; toast('已儲存');
  }),
  integrity: el => run(el, async () => {
    const bad = await S.ops.integrityCheck(false);
    $('#chkOut').innerHTML = bad.length ? `<div class="err">有 ${bad.length} 張單的金額與明細不一致：<br>${bad.map(b => `${esc(b.orderNo)}（${esc(b.fields.join('，'))}）`).join('<br>')}</div>
      <button class="btn pri" data-act="integrityFix">依明細修正</button>` : '<span class="pill closed">全部一致</span>';
  }),
  integrityFix: el => run(el, async () => { await S.ops.integrityCheck(true); $('#chkOut').innerHTML = '<span class="pill closed">已修正</span>'; })
};

document.addEventListener('click', e => {
  const act = e.target.closest('[data-act]');
  if (act) { if (!act.disabled && ACT[act.dataset.act]) ACT[act.dataset.act](act); return; }
  const opt = e.target.closest('[data-group] .opt');
  if (opt) { // 單選按鈕組
    $$('.opt', opt.parentNode).forEach(b => b.classList.toggle('on', b === opt));
    const pay = opt.closest('[data-pay]');
    if (pay) $('.transfer', pay).classList.toggle('hide', !L.isTransfer(opt.dataset.v));
    return;
  }
  if (e.target.id === 'modal') closeModal();
  const row = e.target.closest('#sheet tbody tr');
  if (row && !e.target.closest('input')) openDetail(row.dataset.no);
});
document.addEventListener('input', e => {
  const id = e.target.id;
  if (id === 'q') { S.q = e.target.value; renderList(); }
  else if (id === 'tq') { S.table.q = e.target.value; renderSheet(); }
  else if (id === 'mTotal') updateTail();
  else if (id === 'mRefund') $('#mForfeit').textContent = money(Math.max(S.cur.order.held - (Number(e.target.value) || 0), 0));
  else if (e.target.closest('#items') || id === 'fAmt') updateFormSum();
});
document.addEventListener('change', async e => {
  if (e.target.dataset.post) { // 總表上的轉記勾選
    const box = e.target, no = box.dataset.post;
    box.disabled = true;
    try {
      const o = await S.ops.setPosted(no, box.checked);
      (S.table.rows || []).concat(S.open).filter(r => r.orderNo === no).forEach(r => { r.posted = o.posted; });
      toast(o.posted ? '已標記轉記' : '已取消轉記');
    } catch (err) { box.checked = !box.checked; toast(err.message, true); }
    box.disabled = false;
    return;
  }
  if (e.target.id !== 'fPhone' || S.edit || $('#fName').value.trim()) return;
  try { const name = await S.ops.findCustomer(e.target.value); if (name && $('#fName') && !$('#fName').value.trim()) { $('#fName').value = name; toast(`老客戶：${name}`); } } catch { /* 查不到就手動輸入 */ }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('#modal').classList.contains('hide')) closeModal();
  if (e.key === 'Enter' && e.target.id === 'lgPass') $('[data-act="login"]').click();
});

boot().catch(e => { $('#boot').innerHTML = `<div class="err">系統啟動失敗：${esc(e.message)}</div>`; });
