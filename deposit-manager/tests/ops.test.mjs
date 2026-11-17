import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../public/js/logic.js';
import { createMemoryStore } from '../public/js/store-memory.js';
import { createOps } from '../public/js/ops.js';

function setup(role = 'manager') {
  const store = createMemoryStore();
  const user = { uid: 'u1', name: '測試員', role };
  const ops = createOps(store, { user: () => user, settings: () => L.DEFAULT_SETTINGS });
  return { store, ops, user };
}
const base = (over = {}) => ({ customer: '王小明', phone: '0912-345 678', items: [{ name: 'ARAI RX-7X', spec: 'L', qty: 1, price: 19600 }],
  payment: { method: '現金', amount: 3000 }, ...over });

test('含稅拆分：未稅＋稅額＝含稅', () => {
  for (const a of [1, 105, 3000, 19600, 99999]) { const s = L.splitTax(a); assert.equal(s.net + s.tax, a); }
  assert.deepEqual(L.splitTax(1050), { net: 1000, tax: 50 });
});

test('金額檢查', () => {
  for (const bad of ['', 'abc', -1, 1.5, 0, null]) assert.throws(() => L.toInt(bad, '金額'));
  assert.equal(L.toInt('3000', '金額'), 3000);
  assert.equal(L.toInt(0, '金額', { allowZero: true }), 0);
});

test('CSV 防公式注入與跳脫', () => {
  const csv = L.toCsv([{ a: '=1+1', b: 'x,"y"' }], [['a', 'A'], ['b', 'B']]);
  assert.ok(csv.includes("'=1+1")); assert.ok(csv.includes('"x,""y"""'));
});

test('收訂金：配號、建單、明細、電話整理', async () => {
  const { ops, store } = setup();
  const key = L.twNow().key;
  const o1 = await ops.createOrder(base());
  const o2 = await ops.createOrder(base({ phone: '0987654321', customer: '李大華' }));
  assert.equal(o1.orderNo, `DP-${key}-001`); assert.equal(o2.orderNo, `DP-${key}-002`);
  assert.equal(o1.phone, '0912345678'); assert.equal(o1.totalPrice, 19600); assert.equal(o1.held, 3000);
  const { txs } = await ops.getOrder(o1.orderNo);
  assert.equal(txs.length, 1); assert.equal(txs[0].txId, o1.orderNo + '-01'); assert.equal(txs[0].net + txs[0].tax, 3000);
  assert.equal((await store.query('audit')).length, 2);
});

test('同時送出不會同號', async () => {
  const { ops } = setup();
  const rows = await Promise.all(Array.from({ length: 8 }, () => ops.createOrder(base())));
  assert.equal(new Set(rows.map(r => r.orderNo)).size, 8);
});

test('收訂金的輸入檢查', async () => {
  const { ops, store } = setup();
  await assert.rejects(ops.createOrder(base({ phone: '' })), /電話/);
  await assert.rejects(ops.createOrder(base({ customer: ' ' })), /姓名/);
  await assert.rejects(ops.createOrder(base({ items: [] })), /商品/);
  await assert.rejects(ops.createOrder(base({ payment: { method: '比特幣', amount: 100 } })), /支付方式/);
  await assert.rejects(ops.createOrder(base({ payment: { method: '現金', amount: 0 } })), /金額/);
  await assert.rejects(ops.createOrder(base({ payment: { method: '現金', amount: 20000 } })), /超過/);
  assert.equal((await store.query('orders')).length, 0, '失敗時不應留下任何資料');
  assert.equal((await store.query('counters')).length, 0, '失敗時不應佔用單號');
});

test('追加訂金、到貨、通知、取貨結帳', async () => {
  const { ops } = setup('staff');
  let o = await ops.createOrder(base());
  o = await ops.addDeposit(o.orderNo, { method: '銀行轉帳', amount: 2000, payDate: '2026-11-16', ref: '12345' });
  assert.equal(o.held, 5000);
  await assert.rejects(ops.addDeposit(o.orderNo, { method: '現金', amount: 15000 }), /超過/);
  o = await ops.setStage(o.orderNo, 'arrived'); assert.ok(o.arrivedAt);
  o = await ops.setStage(o.orderNo, 'notified'); assert.ok(o.notifiedAt);
  o = await ops.setStage(o.orderNo, 'arrived'); assert.equal(o.notifiedAt, '');
  o = await ops.closeOrder(o.orderNo, { totalPrice: 19600, method: '信用卡', invoiceNo: 'hp49032133' });
  assert.equal(o.status, 'closed'); assert.equal(o.tail, 14600); assert.equal(o.applied, 5000); assert.equal(o.held, 0);
  const { txs } = await ops.getOrder(o.orderNo);
  assert.deepEqual(txs.map(t => [t.type, t.amount]), [['deposit', 3000], ['deposit', 2000], ['tail', 14600]]);
  const s = L.sums(txs); assert.equal(s.deposit + s.tail, 19600);
  await assert.rejects(ops.addDeposit(o.orderNo, { method: '現金', amount: 1 }), /已取貨/);
  assert.equal((await ops.search('HP49032133')).length, 1);
});

test('取貨結帳：訂金已付全額時不需尾款與支付方式', async () => {
  const { ops } = setup('staff');
  let o = await ops.createOrder(base({ payment: { method: '現金', amount: 19600 } }));
  o = await ops.closeOrder(o.orderNo, { totalPrice: 19600 });
  assert.equal(o.tail, 0); assert.equal((await ops.getOrder(o.orderNo)).txs.length, 1);
  const o2 = await ops.createOrder(base());
  await assert.rejects(ops.closeOrder(o2.orderNo, { totalPrice: 19600 }), /支付方式/);
  await assert.rejects(ops.closeOrder(o2.orderNo, { totalPrice: 2000, method: '現金' }), /低於/);
});

test('退訂：部分退還、其餘沒收；限經理', async () => {
  const staff = setup('staff');
  const o0 = await staff.ops.createOrder(base());
  await assert.rejects(staff.ops.cancelOrder(o0.orderNo, { refundAmount: 3000, method: '現金', reason: 'x' }), /經理/);
  await assert.rejects(staff.ops.voidOrder(o0.orderNo, { reason: 'x' }), /經理/);
  const { ops } = setup();
  let o = await ops.createOrder(base());
  await assert.rejects(ops.cancelOrder(o.orderNo, { refundAmount: 4000, method: '現金', reason: '不要了' }), /超過/);
  await assert.rejects(ops.cancelOrder(o.orderNo, { refundAmount: 1000, method: '現金', reason: '' }), /原因/);
  o = await ops.cancelOrder(o.orderNo, { refundAmount: 2000, method: '現金', reason: '客戶取消' });
  assert.equal(o.status, 'refunded'); assert.equal(o.refunded, 2000); assert.equal(o.forfeited, 1000); assert.equal(o.held, 0);
  const { txs } = await ops.getOrder(o.orderNo);
  assert.deepEqual(txs.map(t => t.type), ['deposit', 'refund', 'forfeit']);
  assert.equal(L.sums(txs).netDeposit, 0);
});

test('作廢：明細標記作廢、不計入報表、單號不重用', async () => {
  const { ops } = setup();
  const o = await ops.createOrder(base());
  const v = await ops.voidOrder(o.orderNo, { reason: '打錯' });
  assert.equal(v.status, 'void');
  const today = L.twNow().date, r = await ops.report(today, today);
  assert.equal(r.totals.inAmt, 0); assert.equal(r.totals.voided, 1);
  const next = await ops.createOrder(base());
  assert.notEqual(next.orderNo, o.orderNo);
});

test('日結：依支付方式彙總，實收－實退', async () => {
  const { ops } = setup();
  const a = await ops.createOrder(base());
  const b = await ops.createOrder(base({ payment: { method: '信用卡', amount: 5000 } }));
  await ops.closeOrder(a.orderNo, { totalPrice: 19600, method: '現金' });
  await ops.cancelOrder(b.orderNo, { refundAmount: 4000, method: '信用卡', reason: '缺貨' });
  const today = L.twNow().date, r = await ops.report(today, today);
  const m = Object.fromEntries(r.methods.map(x => [x.method, x]));
  assert.equal(m['現金'].inAmt, 19600); assert.equal(m['信用卡'].inAmt, 5000); assert.equal(m['信用卡'].outAmt, 4000);
  assert.deepEqual([r.totals.deposit, r.totals.tail, r.totals.refund, r.totals.forfeit, r.totals.net], [8000, 16600, 4000, 1000, 20600]);
  assert.equal(r.totals.netExTax + r.totals.tax, 20600);
});

test('修改資料留下異動紀錄；查詢；老客戶帶入；一致性檢查', async () => {
  const { ops, store } = setup();
  const o = await ops.createOrder(base());
  const e = await ops.updateOrder(o.orderNo, { ...base(), customer: '王 小明', holdUntil: '2026-12-31' });
  assert.equal(e.holdUntil, '2026-12-31');
  const logs = (await store.query('audit')).filter(a => a.action === '修改資料');
  assert.equal(logs.length, 1); assert.ok(logs[0].detail.includes('holdUntil'));
  await assert.rejects(ops.updateOrder(o.orderNo, { ...base(), items: [{ name: 'x', price: 100 }] }), /低於/);
  for (const q of ['0912345678', '5678', '678', '王小明', o.orderNo, o.orderNo.slice(-3)]) assert.equal((await ops.search(q)).length, 1, q);
  assert.equal(await ops.findCustomer('0912 345 678'), '王 小明');
  assert.deepEqual(await ops.integrityCheck(false), []);
  await store.tx(async t => { t.update('orders', o.orderNo, { held: 999 }); });
  assert.equal((await ops.integrityCheck(true)).length, 1);
  assert.equal((await ops.getOrder(o.orderNo)).order.held, 3000);
});

test('會計：只能查看、轉記、匯出；總表與帳本合計', async () => {
  const { ops, user } = setup();
  const a = await ops.createOrder(base());
  await ops.addDeposit(a.orderNo, { method: '信用卡', amount: 1000, invoiceNo: 'ab12345678' });
  const b = await ops.createOrder(base({ payment: { method: '信用卡', amount: 5000 } }));
  await ops.cancelOrder(b.orderNo, { refundAmount: 4000, method: '信用卡', reason: '缺貨' });
  const c = await ops.createOrder(base());
  await ops.closeOrder(c.orderNo, { totalPrice: 19600, method: '現金' });
  user.role = 'accountant';
  await assert.rejects(ops.createOrder(base()), /會計/);
  await assert.rejects(ops.addDeposit(a.orderNo, { method: '現金', amount: 1 }), /會計/);
  await assert.rejects(ops.closeOrder(a.orderNo, { totalPrice: 19600, method: '現金' }), /會計/);
  await assert.rejects(ops.voidOrder(a.orderNo, { reason: 'x' }), /經理/);
  assert.equal((await ops.setPosted(a.orderNo, true)).posted, true);
  const today = L.twNow().date, rows = await ops.listOrders(today, today);
  assert.equal(rows.length, 3); assert.equal(rows.find(r => r.orderNo === a.orderNo).payMethods, '現金、信用卡');
  assert.deepEqual(L.ledgerTotals(rows), { count: 3, deposit: 12000, settled: 3000, cancelled: 5000, open: 4000 });
  assert.equal((await ops.exportAll()).orders.length, 3);
  assert.equal((await ops.search('AB12345678')).length, 1);
  user.role = 'staff';
  await assert.rejects(ops.setPosted(a.orderNo, false), /經理或會計/);
});
