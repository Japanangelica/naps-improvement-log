// 純運算：不碰資料庫與畫面，可單獨測試。

export const STATUS_LABEL = { active: '進行中', closed: '已取貨', refunded: '已退訂', void: '已作廢' };
export const STAGE_LABEL = { ordered: '待到貨', arrived: '已到貨', notified: '已通知' };
export const TYPE_LABEL = { deposit: '訂金', tail: '尾款', refund: '退款', forfeit: '沒收' };
export const ROLE_LABEL = { manager: '經理', staff: '店員' };

export const DEFAULT_SETTINGS = {
  shopName: '台灣 NAPS 新北店',
  prefix: 'DP',
  methods: ['現金', '信用卡', '銀行轉帳', 'LINE Pay', '街口支付', '其他'],
  sources: ['門市', '蝦皮', 'FB', 'LINE', '電話'],
  holdDays: 30,
  taxRate: 5,
  terms: '本訂金於取貨時全額折抵貨款。請於保留期限內取貨，逾期或退訂依本店規定辦理。'
};

/** 需要另外填入金日與帳號末五碼的支付方式。 */
export function isTransfer(method) { return /轉帳|匯款|入金/.test(method || ''); }

/** 以台灣時間回傳日期、時間與單號用的日期鍵。 */
export function twNow(d = new Date()) {
  const p = {};
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).forEach(x => { p[x.type] = x.value; });
  const date = `${p.year}-${p.month}-${p.day}`;
  return { date, time: `${date} ${p.hour}:${p.minute}:${p.second}`, key: date.slice(2).replace(/-/g, '') };
}

export function addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function cleanText(v, max = 300) {
  return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function cleanPhone(v) { return String(v ?? '').replace(/[\s\-()]/g, '').slice(0, 20); }

export function cleanDate(v, label) {
  const s = String(v ?? '').trim();
  if (s && !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`${label}的日期格式不正確`);
  return s;
}

export function toInt(v, label, { allowZero = false } = {}) {
  const n = Number(v);
  if (v === '' || v === null || v === undefined || !Number.isInteger(n) || n < 0 || n > 99999999 || (!allowZero && n === 0)) {
    throw new Error(`${label}請輸入${allowZero ? ' 0 以上' : '大於 0 '}的整數金額`);
  }
  return n;
}

/** 含稅金額拆成未稅額與稅額。 */
export function splitTax(amount, rate = 5) {
  const net = Math.round(amount / (1 + rate / 100));
  return { net, tax: amount - net };
}

/** 檢查並整理品項；空白列略過，至少要有一項。 */
export function normalizeItems(items) {
  const out = [];
  (items || []).forEach((it, i) => {
    const name = cleanText(it.name, 120), spec = cleanText(it.spec, 80);
    if (!name && !spec && !Number(it.price)) return;
    if (!name) throw new Error(`第 ${i + 1} 項商品請輸入品名`);
    const qty = it.qty === '' || it.qty === undefined ? 1 : Number(it.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 999) throw new Error(`「${name}」的數量請輸入 1 以上的整數`);
    out.push({ name, spec, qty, price: toInt(it.price || 0, `「${name}」的單價`, { allowZero: true }) });
  });
  if (!out.length) throw new Error('請至少輸入一項商品');
  if (out.length > 30) throw new Error('品項過多，請分成兩張單');
  return out;
}

export function itemsTotal(items) { return items.reduce((a, it) => a + it.qty * it.price, 0); }

export function itemsText(items) {
  return items.map(it => it.name + (it.spec ? ` ${it.spec}` : '') + (it.qty > 1 ? ` ×${it.qty}` : '')).join('、');
}

export function makeOrderNo(prefix, key, n) { return `${prefix}-${key}-${String(n).padStart(3, '0')}`; }
export function makeTxId(orderNo, n) { return `${orderNo}-${String(n).padStart(2, '0')}`; }

/** 查詢用關鍵字：單號、單號後段、電話、電話末 3～4 碼、姓名、舊編號、發票號碼。 */
export function searchKeys(o) {
  const keys = new Set();
  const add = v => { v = String(v ?? '').trim().toLowerCase(); if (v) keys.add(v); };
  add(o.orderNo); add(o.orderNo.split('-').slice(1).join('-')); add(o.orderNo.split('-').pop());
  add(o.phone); if (o.phone.length >= 4) { add(o.phone.slice(-4)); add(o.phone.slice(-3)); }
  add(o.customer); add(o.customer.replace(/\s/g, ''));
  add(o.legacyNo); add(o.depositInvoice); add(o.finalInvoice);
  return [...keys];
}

/** 由收付明細加總（已作廢的不計）。held＝尚未結案的預收訂金。 */
export function sums(txs) {
  const s = { deposit: 0, tail: 0, refunded: 0, forfeited: 0 };
  txs.forEach(t => {
    if (t.voided) return;
    if (t.type === 'deposit') s.deposit += t.amount;
    else if (t.type === 'tail') s.tail += t.amount;
    else if (t.type === 'refund') s.refunded += t.amount;
    else if (t.type === 'forfeit') s.forfeited += t.amount;
  });
  s.netDeposit = s.deposit - s.refunded - s.forfeited;
  return s;
}

export function isOverdue(o, today) { return o.status === 'active' && !!o.holdUntil && o.holdUntil < today; }

/** 日結／月結彙總。實收＝訂金＋尾款，實退＝退款；依支付方式分列。 */
export function summarize(txs, taxRate = 5) {
  const by = new Map();
  const t = { deposit: 0, tail: 0, refund: 0, forfeit: 0, inAmt: 0, outAmt: 0, voided: 0 };
  txs.forEach(x => {
    if (x.voided) { t.voided++; return; }
    if (x.type === 'forfeit') { t.forfeit += x.amount; return; }
    const m = by.get(x.method) || { method: x.method, inAmt: 0, outAmt: 0, count: 0 };
    by.set(x.method, m); m.count++;
    if (x.type === 'refund') { m.outAmt += x.amount; t.outAmt += x.amount; t.refund += x.amount; }
    else { m.inAmt += x.amount; t.inAmt += x.amount; t[x.type] += x.amount; }
  });
  t.net = t.inAmt - t.outAmt;
  Object.assign(t, { netExTax: splitTax(t.net, taxRate).net, tax: splitTax(t.net, taxRate).tax });
  return { methods: [...by.values()], totals: t };
}

export function toCsv(rows, cols) {
  const cell = v => {
    let s = String(v ?? '');
    if (/^[=+\-@]/.test(s)) s = "'" + s; // 避免在 Excel 中被當成公式
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return '﻿' + [cols.map(c => cell(c[1])).join(',')]
    .concat(rows.map(r => cols.map(c => cell(typeof c[0] === 'function' ? c[0](r) : r[c[0]])).join(','))).join('\r\n');
}
