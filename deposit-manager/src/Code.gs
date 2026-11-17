/**
 * 訂金管理系統 — Google Apps Script 後端
 * 資料存放於本試算表；交易明細為唯一真實來源（只新增、不刪改），
 * 訂金單上的合計欄位一律由交易明細重新計算。
 */
var TZ = 'Asia/Taipei';
var ROLE_MANAGER = '經理';
var ROLE_STAFF = '店員';
var ST = { ACTIVE: '有效', CLOSED: '已結案', REFUNDED: '已退訂', VOID: '已作廢' };
var TX = { PAY: '收款', REDEEM: '沖銷', REFUND: '退款', FORFEIT: '沒收' };

// [程式用鍵名, 試算表標題, 型別]
var SCHEMA = {
  orders: { name: '訂金單', cols: [
    ['orderNo', '單號', 'text'], ['status', '狀態', 'text'], ['createdAt', '建立時間', 'text'],
    ['customer', '客戶姓名', 'text'], ['phone', '電話', 'text'], ['items', '商品內容', 'text'],
    ['totalPrice', '商品總價', 'num'], ['expectedDate', '預計到貨日', 'text'], ['holdUntil', '保留期限', 'text'],
    ['received', '已收訂金', 'num'], ['redeemed', '已沖銷', 'num'], ['refunded', '已退款', 'num'],
    ['forfeited', '已沒收', 'num'], ['balance', '訂金餘額', 'num'], ['posNo', 'POS銷售單號', 'text'],
    ['createdBy', '建立人', 'text'], ['note', '備註', 'text'], ['updatedAt', '更新時間', 'text'],
    ['closedAt', '結案時間', 'text']] },
  ledger: { name: '交易明細', cols: [
    ['txId', '交易編號', 'text'], ['orderNo', '單號', 'text'], ['time', '時間', 'text'],
    ['bizDate', '營業日', 'text'], ['type', '類型', 'text'], ['method', '支付方式', 'text'],
    ['amount', '金額', 'num'], ['ref', '參考號', 'text'], ['staff', '經手人', 'text'],
    ['note', '備註', 'text'], ['requestId', '請求ID', 'text'], ['voided', '作廢', 'text']] },
  staff: { name: '人員', cols: [
    ['name', '姓名', 'text'], ['role', '角色', 'text'], ['pinHash', 'PIN雜湊', 'text'], ['active', '啟用', 'text']] },
  settings: { name: '設定', cols: [['key', '項目', 'text'], ['value', '內容', 'text']] },
  seq: { name: '序號', cols: [['dateKey', '日期', 'text'], ['last', '最後序號', 'num']] },
  audit: { name: '異動紀錄', cols: [
    ['time', '時間', 'text'], ['staff', '人員', 'text'], ['action', '動作', 'text'],
    ['orderNo', '單號', 'text'], ['detail', '內容', 'text']] }
};

var DEFAULT_SETTINGS = [
  ['店名', '訂金管理'],
  ['單號前綴', 'DP'],
  ['支付方式', '現金,信用卡,LINE Pay,街口支付,全支付,悠遊付,Apple Pay,銀行轉帳,其他'],
  ['預設保留天數', '30'],
  ['退款需經理權限', '是'],
  ['收據條款', '本訂金於取貨時全額折抵貨款。請於保留期限內取貨，逾期或退訂依本店規定辦理。'],
  ['提醒Email', '']
];

/* ---------- 資料存取層 ---------- */

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function sheet_(t) {
  var sh = ss_().getSheetByName(SCHEMA[t].name);
  if (!sh) throw new Error('找不到工作表「' + SCHEMA[t].name + '」，請先在試算表選單執行「初始化系統」');
  return sh;
}

function cast_(v, type) {
  if (type === 'num') { var n = Number(v); return isFinite(n) ? n : 0; }
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return fmt_(v, 'yyyy-MM-dd HH:mm:ss').replace(' 00:00:00', '');
  }
  return v === null || v === undefined ? '' : String(v);
}

function read_(t) {
  var sh = sheet_(t), cols = SCHEMA[t].cols, last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, cols.length).getValues().map(function (r, i) {
    var o = { _row: i + 2 };
    cols.forEach(function (c, j) { o[c[0]] = cast_(r[j], c[2]); });
    return o;
  });
}

/** 寫入一列（row 省略時為新增）。先設定儲存格格式再寫值，避免電話開頭的 0 或日期被自動轉型。 */
function write_(t, o, row) {
  var sh = sheet_(t), cols = SCHEMA[t].cols;
  if (!row) row = Math.max(sh.getLastRow(), 1) + 1;
  if (row > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 200);
  var rng = sh.getRange(row, 1, 1, cols.length);
  rng.setNumberFormats([cols.map(function (c) { return c[2] === 'num' ? '#,##0' : '@'; })]);
  rng.setValues([cols.map(function (c) {
    var v = o[c[0]];
    return c[2] === 'num' ? (Number(v) || 0) : (v === null || v === undefined ? '' : String(v));
  })]);
  o._row = row;
  return o;
}

function fmt_(d, f) { return Utilities.formatDate(d, TZ, f); }
function nowStr_() { return fmt_(new Date(), 'yyyy-MM-dd HH:mm:ss'); }
function today_() { return fmt_(new Date(), 'yyyy-MM-dd'); }

function locked_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function audit_(staff, action, orderNo, detail) {
  write_('audit', { time: nowStr_(), staff: staff, action: action, orderNo: orderNo || '',
    detail: typeof detail === 'string' ? detail : JSON.stringify(detail || {}) });
}

function getSettings_() {
  var m = {};
  DEFAULT_SETTINGS.forEach(function (d) { m[d[0]] = d[1]; });
  read_('settings').forEach(function (r) { if (r.key) m[r.key] = r.value; });
  var methods = m['支付方式'].split(/[,，、]/).map(function (s) { return s.trim(); }).filter(String);
  return {
    shopName: m['店名'], prefix: (m['單號前綴'] || 'DP').replace(/[^A-Za-z0-9]/g, '') || 'DP',
    methods: methods, holdDays: parseInt(m['預設保留天數'], 10) || 0,
    refundNeedsManager: m['退款需經理權限'] !== '否', terms: m['收據條款'], remindEmail: m['提醒Email']
  };
}

/* ---------- 輸入檢查 ---------- */

/** 自由文字：去頭尾空白、去除會被試算表當成公式的開頭字元、限制長度。 */
function text_(v, max) {
  return String(v === null || v === undefined ? '' : v).trim().replace(/^[=+\-@\s]+/, '').slice(0, max || 500);
}

function amount_(v, label, allowZero) {
  var n = Number(v);
  if (!isFinite(n) || Math.floor(n) !== n || n < 0 || (!allowZero && n === 0) || n > 99999999) {
    throw new Error(label + '必須是' + (allowZero ? '0 以上' : '大於 0 ') + '的整數');
  }
  return n;
}

function date_(v, label) {
  var s = String(v || '').trim();
  if (s && !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(label + '格式錯誤（應為 YYYY-MM-DD）');
  return s;
}

function method_(v, settings) {
  var s = String(v || '').trim();
  if (settings.methods.indexOf(s) < 0) throw new Error('請選擇支付方式');
  return s;
}

function reqId_(v) {
  var s = String(v || '');
  if (!/^[A-Za-z0-9\-]{8,64}$/.test(s)) throw new Error('請求識別碼遺失，請重新整理頁面後再試');
  return s;
}

/* ---------- 登入與權限 ---------- */

function salt_() {
  var p = PropertiesService.getScriptProperties(), s = p.getProperty('SALT');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); p.setProperty('SALT', s); }
  return s;
}

function hash_(pin) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt_() + ':' + pin, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}

function setStaff_(name, role, pin) {
  name = text_(name, 30);
  if (!name) throw new Error('請輸入姓名');
  if (role !== ROLE_MANAGER && role !== ROLE_STAFF) throw new Error('角色必須是「經理」或「店員」');
  if (!/^\d{4,8}$/.test(String(pin))) throw new Error('PIN 必須是 4～8 位數字');
  var rows = read_('staff'), hit = rows.filter(function (r) { return r.name === name; })[0];
  write_('staff', { name: name, role: role, pinHash: hash_(String(pin)), active: '是' }, hit && hit._row);
}

function auth_(token, needManager) {
  var raw = token ? CacheService.getScriptCache().get('tok:' + token) : null;
  if (!raw) throw new Error('登入已逾時，請重新登入');
  var u = JSON.parse(raw);
  if (needManager && u.role !== ROLE_MANAGER) throw new Error('此操作需要經理權限');
  return u;
}

function apiBootstrap() {
  var s = getSettings_();
  return {
    shopName: s.shopName,
    staff: read_('staff').filter(function (r) { return r.active === '是' && r.name; })
      .map(function (r) { return r.name; })
  };
}

function apiLogin(name, pin) {
  var cache = CacheService.getScriptCache(), failKey = 'fail:' + name;
  var fails = Number(cache.get(failKey)) || 0;
  if (fails >= 5) throw new Error('PIN 錯誤次數過多，請 10 分鐘後再試');
  var u = read_('staff').filter(function (r) { return r.name === name && r.active === '是'; })[0];
  if (!u || !/^\d{4,8}$/.test(String(pin)) || u.pinHash !== hash_(String(pin))) {
    cache.put(failKey, String(fails + 1), 600);
    throw new Error('姓名或 PIN 錯誤');
  }
  cache.remove(failKey);
  var token = Utilities.getUuid();
  cache.put('tok:' + token, JSON.stringify({ name: u.name, role: u.role }), 21600);
  var s = getSettings_();
  return { token: token, name: u.name, role: u.role, isManager: u.role === ROLE_MANAGER, today: today_(),
    settings: { shopName: s.shopName, methods: s.methods, holdDays: s.holdDays,
      refundNeedsManager: s.refundNeedsManager, terms: s.terms } };
}

function apiLogout(token) {
  if (token) CacheService.getScriptCache().remove('tok:' + token);
  return true;
}

/* ---------- 單號 ---------- */

/** 單號：前綴-YYMMDD-流水號（每日從 001 起）。須在鎖定內呼叫；號碼用過即不重複使用。 */
function nextNo_(prefix, orders) {
  var key = fmt_(new Date(), 'yyMMdd');
  var rows = read_('seq'), hit = rows.filter(function (r) { return r.dateKey === key; })[0];
  var n = hit ? hit.last : 0, no, used = {};
  orders.forEach(function (o) { used[o.orderNo] = true; });
  do { n++; no = prefix + '-' + key + '-' + (n < 1000 ? ('00' + n).slice(-3) : String(n)); } while (used[no]);
  write_('seq', { dateKey: key, last: n }, hit && hit._row);
  return no;
}

/* ---------- 核心運算 ---------- */

function sums_(txs) {
  var s = { received: 0, redeemed: 0, refunded: 0, forfeited: 0 };
  txs.forEach(function (t) {
    if (t.voided === '是') return;
    if (t.type === TX.PAY) s.received += t.amount;
    else if (t.type === TX.REDEEM) s.redeemed += t.amount;
    else if (t.type === TX.REFUND) s.refunded += t.amount;
    else if (t.type === TX.FORFEIT) s.forfeited += t.amount;
  });
  s.balance = s.received - s.redeemed - s.refunded - s.forfeited;
  return s;
}

function findOrder_(orders, orderNo) {
  var o = orders.filter(function (r) { return r.orderNo === String(orderNo || '').trim(); })[0];
  if (!o) throw new Error('找不到訂金單：' + orderNo);
  return o;
}

function txsOf_(ledger, orderNo) { return ledger.filter(function (t) { return t.orderNo === orderNo; }); }

function view_(orderNo) {
  var o = findOrder_(read_('orders'), orderNo);
  return { order: o, txs: txsOf_(read_('ledger'), o.orderNo) };
}

function dupReq_(ledger, requestId) {
  return ledger.filter(function (t) { return t.requestId === requestId; })[0] || null;
}

/** 新增交易並回傳新增的列。 */
function addTx_(ledger, orderNo, type, method, amount, ref, staff, note, requestId) {
  var n = txsOf_(ledger, orderNo).length + 1;
  var tx = write_('ledger', { txId: orderNo + '-' + ('0' + n).slice(-2), orderNo: orderNo, time: nowStr_(),
    bizDate: today_(), type: type, method: method || '', amount: amount, ref: ref || '', staff: staff,
    note: note || '', requestId: requestId, voided: '' });
  ledger.push(tx);
  return tx;
}

/** 依交易明細重算訂金單合計與狀態後寫回。closeAs：餘額歸零時要標記的狀態。 */
function refresh_(order, ledger, closeAs) {
  var s = sums_(txsOf_(ledger, order.orderNo));
  order.received = s.received; order.redeemed = s.redeemed; order.refunded = s.refunded;
  order.forfeited = s.forfeited; order.balance = s.balance;
  order.updatedAt = nowStr_();
  if (order.status === ST.ACTIVE && s.balance === 0 && closeAs) { order.status = closeAs; order.closedAt = order.updatedAt; }
  write_('orders', order, order._row);
}

function requireActive_(order) {
  if (order.status !== ST.ACTIVE) throw new Error('此訂金單狀態為「' + order.status + '」，無法執行此操作');
}

/* ---------- 對外 API ---------- */

function apiCreateDeposit(token, p) {
  var u = auth_(token);
  return locked_(function () {
    var requestId = reqId_(p.requestId), ledger = read_('ledger');
    var dup = dupReq_(ledger, requestId);
    if (dup) return view_(dup.orderNo);
    var settings = getSettings_();
    var customer = text_(p.customer, 50), phone = text_(p.phone, 30), items = text_(p.items, 500);
    if (!customer) throw new Error('請輸入客戶姓名');
    if (!phone) throw new Error('請輸入電話');
    if (!items) throw new Error('請輸入商品內容');
    var totalPrice = amount_(p.totalPrice || 0, '商品總價', true);
    var expectedDate = date_(p.expectedDate, '預計到貨日'), holdUntil = date_(p.holdUntil, '保留期限');
    if (!p.payments || !p.payments.length) throw new Error('請至少輸入一筆收款');
    if (p.payments.length > 10) throw new Error('收款筆數過多');
    var pays = p.payments.map(function (x) {
      return { method: method_(x.method, settings), amount: amount_(x.amount, '收款金額'), ref: text_(x.ref, 60) };
    });
    var total = pays.reduce(function (a, x) { return a + x.amount; }, 0);
    if (totalPrice > 0 && total > totalPrice) throw new Error('訂金合計不可超過商品總價');

    var orders = read_('orders'), now = nowStr_();
    var order = write_('orders', { orderNo: nextNo_(settings.prefix, orders), status: ST.ACTIVE, createdAt: now,
      customer: customer, phone: phone, items: items, totalPrice: totalPrice, expectedDate: expectedDate,
      holdUntil: holdUntil, received: 0, redeemed: 0, refunded: 0, forfeited: 0, balance: 0, posNo: '',
      createdBy: u.name, note: text_(p.note, 500), updatedAt: now, closedAt: '' });
    pays.forEach(function (x) { addTx_(ledger, order.orderNo, TX.PAY, x.method, x.amount, x.ref, u.name, '', requestId); });
    refresh_(order, ledger);
    audit_(u.name, '建立訂金單', order.orderNo, { 訂金: total, 收款: pays });
    return { order: order, txs: txsOf_(ledger, order.orderNo) };
  });
}

/** 共用：對既有訂金單新增交易的流程（冪等、鎖定、重算）。 */
function txFlow_(token, p, needManager, fn) {
  var u = auth_(token, needManager);
  return locked_(function () {
    var requestId = reqId_(p.requestId), ledger = read_('ledger');
    var dup = dupReq_(ledger, requestId);
    if (dup) return view_(dup.orderNo);
    var order = findOrder_(read_('orders'), p.orderNo);
    requireActive_(order);
    fn(u, order, ledger, requestId, getSettings_());
    return { order: order, txs: txsOf_(ledger, order.orderNo) };
  });
}

function apiAddPayment(token, p) {
  return txFlow_(token, p, false, function (u, order, ledger, requestId, settings) {
    var amount = amount_(p.amount, '收款金額'), method = method_(p.method, settings);
    if (order.totalPrice > 0 && order.received - order.refunded + amount > order.totalPrice) {
      throw new Error('累計訂金不可超過商品總價');
    }
    addTx_(ledger, order.orderNo, TX.PAY, method, amount, text_(p.ref, 60), u.name, text_(p.note, 200), requestId);
    refresh_(order, ledger);
    audit_(u.name, '追加訂金', order.orderNo, { 金額: amount, 方式: method });
  });
}

function apiRedeem(token, p) {
  return txFlow_(token, p, false, function (u, order, ledger, requestId) {
    var amount = amount_(p.amount, '沖銷金額'), posNo = text_(p.posNo, 60);
    if (amount > order.balance) throw new Error('沖銷金額不可超過訂金餘額（' + order.balance + '）');
    addTx_(ledger, order.orderNo, TX.REDEEM, '', amount, posNo, u.name, text_(p.note, 200), requestId);
    if (posNo) order.posNo = order.posNo ? order.posNo + ', ' + posNo : posNo;
    refresh_(order, ledger, ST.CLOSED);
    audit_(u.name, '取貨沖銷', order.orderNo, { 金額: amount, POS單號: posNo });
  });
}

function apiRefund(token, p) {
  var needManager = getSettings_().refundNeedsManager;
  return txFlow_(token, p, needManager, function (u, order, ledger, requestId, settings) {
    var refund = amount_(p.refundAmount || 0, '退款金額', true);
    var forfeit = amount_(p.forfeitAmount || 0, '沒收金額', true);
    var reason = text_(p.reason, 200);
    if (refund + forfeit === 0) throw new Error('請輸入退款或沒收金額');
    if (refund + forfeit > order.balance) throw new Error('退款＋沒收不可超過訂金餘額（' + order.balance + '）');
    if (!reason) throw new Error('請輸入退訂原因');
    var method = refund > 0 ? method_(p.method, settings) : '';
    if (refund > 0) addTx_(ledger, order.orderNo, TX.REFUND, method, refund, text_(p.ref, 60), u.name, reason, requestId);
    if (forfeit > 0) addTx_(ledger, order.orderNo, TX.FORFEIT, '', forfeit, '', u.name, reason, requestId);
    refresh_(order, ledger, ST.REFUNDED);
    audit_(u.name, '退訂', order.orderNo, { 退款: refund, 方式: method, 沒收: forfeit, 原因: reason });
  });
}

function apiUpdateOrder(token, p) {
  var u = auth_(token);
  return locked_(function () {
    var order = findOrder_(read_('orders'), p.orderNo);
    requireActive_(order);
    var next = { customer: text_(p.customer, 50), phone: text_(p.phone, 30), items: text_(p.items, 500),
      totalPrice: amount_(p.totalPrice || 0, '商品總價', true), expectedDate: date_(p.expectedDate, '預計到貨日'),
      holdUntil: date_(p.holdUntil, '保留期限'), note: text_(p.note, 500) };
    if (!next.customer || !next.phone || !next.items) throw new Error('客戶姓名、電話、商品內容不可空白');
    if (next.totalPrice > 0 && order.received - order.refunded > next.totalPrice) throw new Error('商品總價不可低於已收訂金');
    var diff = {};
    Object.keys(next).forEach(function (k) {
      if (order[k] !== next[k]) { diff[k] = [order[k], next[k]]; order[k] = next[k]; }
    });
    if (Object.keys(diff).length) {
      order.updatedAt = nowStr_();
      write_('orders', order, order._row);
      audit_(u.name, '修改訂金單', order.orderNo, diff);
    }
    return { order: order, txs: txsOf_(read_('ledger'), order.orderNo) };
  });
}

/** 作廢：用於登打錯誤。交易保留但標記作廢，不計入任何報表；單號不重複使用。 */
function apiVoid(token, p) {
  var u = auth_(token, true);
  return locked_(function () {
    var order = findOrder_(read_('orders'), p.orderNo), reason = text_(p.reason, 200);
    if (order.status === ST.VOID) return view_(order.orderNo);
    if (!reason) throw new Error('請輸入作廢原因');
    var ledger = read_('ledger'), before = sums_(txsOf_(ledger, order.orderNo));
    txsOf_(ledger, order.orderNo).forEach(function (t) {
      if (t.voided !== '是') { t.voided = '是'; write_('ledger', t, t._row); }
    });
    order.status = ST.VOID; order.closedAt = nowStr_();
    order.note = (order.note ? order.note + '／' : '') + '作廢原因：' + reason;
    refresh_(order, ledger);
    audit_(u.name, '作廢', order.orderNo, { 原因: reason, 作廢前: before });
    return { order: order, txs: txsOf_(ledger, order.orderNo) };
  });
}

function apiGetOrder(token, orderNo) { auth_(token); return view_(orderNo); }

function apiSearch(token, p) {
  auth_(token);
  var q = String((p && p.q) || '').trim().toLowerCase(), status = (p && p.status) || '';
  var rows = read_('orders').filter(function (o) {
    if (status && o.status !== status) return false;
    if (!q) return true;
    return [o.orderNo, o.customer, o.phone, o.items, o.posNo].join('\n').toLowerCase().indexOf(q) >= 0;
  });
  rows.reverse();
  return { total: rows.length, rows: rows.slice(0, 100) };
}

/** 日結報表：依營業日彙總各支付方式的收款／退款，供對帳。 */
function apiDailyReport(token, date) {
  auth_(token);
  date = date_(date, '日期') || today_();
  var all = read_('ledger').filter(function (t) { return t.bizDate === date; });
  var txs = all.filter(function (t) { return t.voided !== '是'; });
  var by = {}, tot = { inAmt: 0, outAmt: 0, redeemed: 0, forfeited: 0 };
  txs.forEach(function (t) {
    if (t.type === TX.PAY || t.type === TX.REFUND) {
      var m = by[t.method] || (by[t.method] = { method: t.method, inAmt: 0, outAmt: 0, count: 0 });
      m.count++;
      if (t.type === TX.PAY) { m.inAmt += t.amount; tot.inAmt += t.amount; }
      else { m.outAmt += t.amount; tot.outAmt += t.amount; }
    } else if (t.type === TX.REDEEM) tot.redeemed += t.amount;
    else if (t.type === TX.FORFEIT) tot.forfeited += t.amount;
  });
  return { date: date, methods: Object.keys(by).map(function (k) { return by[k]; }), totals: tot,
    voidedCount: all.length - txs.length, txs: txs };
}

/** 未結訂金（預收款餘額）清單，依保留期限排序。 */
function apiOutstanding(token) {
  auth_(token);
  var today = today_();
  var rows = read_('orders').filter(function (o) { return o.status === ST.ACTIVE; });
  rows.forEach(function (o) { o.overdue = !!o.holdUntil && o.holdUntil < today; });
  rows.sort(function (a, b) { return (a.holdUntil || '9999') < (b.holdUntil || '9999') ? -1 : 1; });
  return { today: today, count: rows.length,
    balance: rows.reduce(function (a, o) { return a + o.balance; }, 0),
    overdueCount: rows.filter(function (o) { return o.overdue; }).length, rows: rows };
}

/* ---------- 維護工具 ---------- */

/** 以交易明細重算所有訂金單，回傳與現有數字不符的清單；fix=true 時一併修正。 */
function integrityCheck_(fix) {
  return locked_(function () {
    var ledger = read_('ledger'), bad = [];
    read_('orders').forEach(function (o) {
      var s = sums_(txsOf_(ledger, o.orderNo));
      var keys = ['received', 'redeemed', 'refunded', 'forfeited', 'balance'];
      if (keys.some(function (k) { return o[k] !== s[k]; })) {
        bad.push(o.orderNo);
        if (fix) { keys.forEach(function (k) { o[k] = s[k]; }); write_('orders', o, o._row); }
      }
    });
    return bad;
  });
}

function setup_() {
  var ss = ss_();
  Object.keys(SCHEMA).forEach(function (t) {
    var def = SCHEMA[t], sh = ss.getSheetByName(def.name) || ss.insertSheet(def.name);
    sh.getRange(1, 1, 1, def.cols.length).setValues([def.cols.map(function (c) { return c[1]; })]).setFontWeight('bold');
    sh.setFrozenRows(1);
  });
  var have = {};
  read_('settings').forEach(function (r) { have[r.key] = true; });
  DEFAULT_SETTINGS.forEach(function (d) { if (!have[d[0]]) write_('settings', { key: d[0], value: d[1] }); });
  salt_();
}

/** 每日提醒：逾期或 3 天內到期的未結訂金，寄信給店長。 */
function dailyReminder() {
  var s = getSettings_(), today = today_();
  var limit = fmt_(new Date(Date.now() + 3 * 86400000), 'yyyy-MM-dd');
  var rows = read_('orders').filter(function (o) { return o.status === ST.ACTIVE && o.holdUntil && o.holdUntil <= limit; });
  if (!rows.length) return 0;
  var to = s.remindEmail || Session.getEffectiveUser().getEmail();
  var lines = rows.map(function (o) {
    return (o.holdUntil < today ? '【已逾期】' : '【即將到期】') + o.orderNo + '　' + o.customer + '　' + o.phone +
      '　期限 ' + o.holdUntil + '　餘額 $' + o.balance + '\n　' + o.items;
  });
  MailApp.sendEmail(to, '[' + s.shopName + '] 訂金保留期限提醒（' + rows.length + ' 筆）', lines.join('\n\n'));
  return rows.length;
}

/* ---------- 網頁與試算表選單 ---------- */

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index').setTitle('訂金管理')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('訂金管理')
    .addItem('① 初始化系統', 'menuSetup')
    .addItem('② 新增／重設人員 PIN', 'menuSetStaff')
    .addItem('③ 啟用每日到期提醒信', 'menuInstallReminder')
    .addSeparator()
    .addItem('資料一致性檢查', 'menuIntegrity')
    .addToUi();
}

function menuSetup() {
  setup_();
  SpreadsheetApp.getUi().alert('初始化完成。請接著執行「② 新增／重設人員 PIN」建立經理帳號。');
}

function menuSetStaff() {
  var ui = SpreadsheetApp.getUi(), ask = function (msg) {
    var r = ui.prompt('人員設定', msg, ui.ButtonSet.OK_CANCEL);
    return r.getSelectedButton() === ui.Button.OK ? r.getResponseText().trim() : null;
  };
  var name = ask('姓名（已存在則重設其角色與 PIN）：'); if (name === null) return;
  var role = ask('角色（輸入「經理」或「店員」）：'); if (role === null) return;
  var pin = ask('PIN（4～8 位數字）：'); if (pin === null) return;
  try { setStaff_(name, role, pin); ui.alert('已設定：' + name + '（' + role + '）'); }
  catch (e) { ui.alert('設定失敗：' + e.message); }
}

function menuInstallReminder() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailyReminder') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyReminder').timeBased().everyDays(1).atHour(9).create();
  SpreadsheetApp.getUi().alert('已啟用：每天早上 9 點左右寄送到期提醒。');
}

function menuIntegrity() {
  var ui = SpreadsheetApp.getUi(), bad = integrityCheck_(false);
  if (!bad.length) { ui.alert('檢查完成，所有訂金單與交易明細一致。'); return; }
  var r = ui.alert('發現 ' + bad.length + ' 筆不一致', bad.join(', ') + '\n\n是否依交易明細修正？', ui.ButtonSet.YES_NO);
  if (r === ui.Button.YES) { integrityCheck_(true); ui.alert('已修正。'); }
}
