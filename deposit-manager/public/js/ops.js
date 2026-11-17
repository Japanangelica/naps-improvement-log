// 業務操作：所有會動到錢或狀態的動作都在這裡，並包在資料庫交易內。
import * as L from './logic.js';

/**
 * @param store   資料庫（store-firebase.js 或 store-memory.js）
 * @param ctx     { user(): {uid,name,role}, settings(): 設定 }
 */
export function createOps(store, ctx) {
  const me = () => {
    const u = ctx.user();
    if (!u) throw new Error('請先登入');
    return u;
  };
  const needManager = () => {
    const u = me();
    if (u.role !== 'manager') throw new Error('這個操作需要經理帳號');
    return u;
  };
  /** 會動到訂金單的操作：店員與經理可用，會計不可。 */
  const seller = () => {
    const u = me();
    if (u.role === 'accountant') throw new Error('會計帳號只能查看、轉記與匯出');
    return u;
  };
  /** 轉記與匯出：經理與會計可用。 */
  const bookkeeper = () => {
    const u = me();
    if (u.role !== 'manager' && u.role !== 'accountant') throw new Error('這個操作需要經理或會計帳號');
    return u;
  };
  const cfg = () => ctx.settings();
  const audit = (t, u, action, orderNo, detail) => t.add('audit', {
    time: L.twNow().time, ts: store.serverTime(), staff: u.name, staffUid: u.uid, action, orderNo,
    detail: JSON.stringify(detail || {})
  });

  function payment(p, label) {
    const method = L.cleanText(p.method, 30);
    if (!cfg().methods.includes(method)) throw new Error('請選擇支付方式');
    return { method, amount: L.toInt(p.amount, label), payDate: L.cleanDate(p.payDate, '入金日'),
      ref: L.cleanText(p.ref, 60), invoiceNo: L.cleanText(p.invoiceNo, 30).toUpperCase(), note: L.cleanText(p.note, 200) };
  }

  /** 建立一筆收付明細（文件 ID＝收據編號）。 */
  function writeTx(t, u, order, n, type, pay) {
    const now = L.twNow(), { net, tax } = L.splitTax(pay.amount, cfg().taxRate);
    const tx = { txId: L.makeTxId(order.orderNo, n), orderNo: order.orderNo, customer: order.customer,
      time: now.time, bizDate: now.date, ts: store.serverTime(), type, method: pay.method || '', amount: pay.amount,
      net, tax, payDate: pay.payDate || '', ref: pay.ref || '', invoiceNo: pay.invoiceNo || '',
      note: pay.note || '', staff: u.name, staffUid: u.uid, voided: false };
    t.set('transactions', tx.txId, tx);
    return tx;
  }

  async function loadActive(t, orderNo) {
    const o = await t.get('orders', String(orderNo));
    if (!o) throw new Error(`找不到訂金單 ${orderNo}`);
    if (o.status !== 'active') throw new Error(`這張單${L.STATUS_LABEL[o.status]}，不能再操作`);
    return o;
  }

  function orderFields(p) {
    const customer = L.cleanText(p.customer, 50), phone = L.cleanPhone(p.phone);
    if (!phone) throw new Error('請輸入電話');
    if (!customer) throw new Error('請輸入客戶姓名');
    const items = L.normalizeItems(p.items);
    return { customer, phone, items, itemsText: L.itemsText(items), totalPrice: L.itemsTotal(items),
      source: L.cleanText(p.source, 20), expectedDate: L.cleanDate(p.expectedDate, '預計到貨日'),
      holdUntil: L.cleanDate(p.holdUntil, '保留期限'), note: L.cleanText(p.note, 500) };
  }

  return {
    /** 收訂金：配號、建單、寫入第一筆訂金，一次完成。 */
    async createOrder(p) {
      const u = seller(), f = orderFields(p), pay = payment(p.payment || {}, '訂金金額');
      if (f.totalPrice > 0 && pay.amount > f.totalPrice) throw new Error('訂金不能超過商品總價');
      const now = L.twNow();
      return store.tx(async t => {
        const counter = await t.get('counters', now.key);
        const n = (counter ? counter.last : 0) + 1;
        const orderNo = L.makeOrderNo(cfg().prefix, now.key, n);
        if (await t.get('orders', orderNo)) throw new Error('單號重複，請再按一次');
        const order = { orderNo, status: 'active', stage: 'ordered', createdAt: now.time, bizDate: now.date, ...f,
          deposit: pay.amount, tail: 0, refunded: 0, forfeited: 0, held: pay.amount, applied: 0, payMethods: pay.method,
          arrivedAt: '', notifiedAt: '', closedAt: '', closedBy: '', depositInvoice: pay.invoiceNo, finalInvoice: '',
          legacyNo: '', posted: false, createdBy: u.name, createdByUid: u.uid, updatedAt: now.time, txCount: 1 };
        order.keys = L.searchKeys(order);
        t.set('counters', now.key, { last: n });
        t.set('orders', orderNo, order);
        writeTx(t, u, order, 1, 'deposit', pay);
        audit(t, u, '收訂金', orderNo, { 訂金: pay.amount, 方式: pay.method });
        return order;
      });
    },

    async addDeposit(orderNo, p) {
      const u = seller(), pay = payment(p, '訂金金額');
      return store.tx(async t => {
        const o = await loadActive(t, orderNo);
        if (o.totalPrice > 0 && o.held + pay.amount > o.totalPrice) throw new Error('累計訂金不能超過商品總價');
        const methods = (o.payMethods || '').split('、').filter(Boolean);
        if (!methods.includes(pay.method)) methods.push(pay.method);
        const patch = { deposit: o.deposit + pay.amount, held: o.held + pay.amount, txCount: o.txCount + 1, updatedAt: L.twNow().time,
          payMethods: methods.join('、'), depositInvoice: [o.depositInvoice, pay.invoiceNo].filter(Boolean).join('、') };
        patch.keys = L.searchKeys({ ...o, ...patch });
        t.update('orders', o.orderNo, patch);
        writeTx(t, u, o, o.txCount + 1, 'deposit', pay);
        audit(t, u, '追加訂金', o.orderNo, { 金額: pay.amount, 方式: pay.method });
        return { ...o, ...patch };
      });
    },

    /** 標記到貨／已通知（也可改回前一階段）。 */
    async setStage(orderNo, stage) {
      const u = seller();
      if (!L.STAGE_LABEL[stage]) throw new Error('階段不正確');
      return store.tx(async t => {
        const o = await loadActive(t, orderNo), today = L.twNow();
        const patch = { stage, updatedAt: today.time,
          arrivedAt: stage === 'ordered' ? '' : (o.arrivedAt || today.date),
          notifiedAt: stage === 'notified' ? (o.notifiedAt || today.date) : '' };
        t.update('orders', o.orderNo, patch);
        audit(t, u, '更新階段', o.orderNo, { 階段: L.STAGE_LABEL[stage] });
        return { ...o, ...patch };
      });
    },

    /** 取貨結帳：訂金全額折抵，收尾款（可為 0），結案。 */
    async closeOrder(orderNo, p) {
      const u = seller(), totalPrice = L.toInt(p.totalPrice, '商品總價');
      return store.tx(async t => {
        const o = await loadActive(t, orderNo), tailAmt = totalPrice - o.held;
        if (tailAmt < 0) throw new Error(`商品總價低於已收訂金 ${o.held} 元，請先確認金額`);
        const pay = tailAmt > 0 ? payment({ ...p, amount: tailAmt }, '尾款') : null;
        const now = L.twNow(), finalInvoice = L.cleanText(p.invoiceNo, 30).toUpperCase();
        const patch = { status: 'closed', totalPrice, tail: tailAmt, applied: o.held, held: 0, closedAt: now.time,
          closedBy: u.name, finalInvoice, arrivedAt: o.arrivedAt || now.date, updatedAt: now.time,
          txCount: o.txCount + (pay ? 1 : 0) };
        patch.keys = L.searchKeys({ ...o, ...patch });
        t.update('orders', o.orderNo, patch);
        if (pay) writeTx(t, u, o, o.txCount + 1, 'tail', pay);
        audit(t, u, '取貨結帳', o.orderNo, { 商品總價: totalPrice, 訂金折抵: o.held, 尾款: tailAmt, 方式: pay ? pay.method : '' });
        return { ...o, ...patch };
      });
    },

    /** 退訂：退還一部分或全部訂金，未退還的部分自動列為沒收。限經理。 */
    async cancelOrder(orderNo, p) {
      const u = needManager(), refund = L.toInt(p.refundAmount, '退還金額', { allowZero: true });
      const reason = L.cleanText(p.reason, 200);
      if (!reason) throw new Error('請輸入退訂原因');
      return store.tx(async t => {
        const o = await loadActive(t, orderNo);
        if (refund > o.held) throw new Error(`退還金額不能超過已收訂金 ${o.held} 元`);
        const forfeit = o.held - refund, now = L.twNow();
        let n = o.txCount;
        const patch = { status: 'refunded', refunded: o.refunded + refund, forfeited: o.forfeited + forfeit, held: 0,
          closedAt: now.time, closedBy: u.name, updatedAt: now.time, note: [o.note, `退訂原因：${reason}`].filter(Boolean).join('／') };
        if (refund > 0) writeTx(t, u, o, ++n, 'refund', { ...payment({ ...p, amount: refund }, '退還金額'), note: reason });
        if (forfeit > 0) writeTx(t, u, o, ++n, 'forfeit', { amount: forfeit, note: reason });
        patch.txCount = n;
        t.update('orders', o.orderNo, patch);
        audit(t, u, '退訂', o.orderNo, { 退還: refund, 沒收: forfeit, 原因: reason });
        return { ...o, ...patch };
      });
    },

    /** 作廢：只用於登打錯誤。明細保留但標記作廢，不計入任何報表。限經理。 */
    async voidOrder(orderNo, p) {
      const u = needManager(), reason = L.cleanText(p.reason, 200);
      if (!reason) throw new Error('請輸入作廢原因');
      return store.tx(async t => {
        const o = await t.get('orders', String(orderNo));
        if (!o) throw new Error(`找不到訂金單 ${orderNo}`);
        if (o.status === 'void') return o;
        const ids = Array.from({ length: o.txCount }, (_, i) => L.makeTxId(o.orderNo, i + 1));
        const txs = [];
        for (const id of ids) txs.push(await t.get('transactions', id));
        const now = L.twNow();
        const patch = { status: 'void', held: 0, closedAt: now.time, closedBy: u.name, updatedAt: now.time,
          note: [o.note, `作廢原因：${reason}`].filter(Boolean).join('／') };
        t.update('orders', o.orderNo, patch);
        txs.forEach((x, i) => { if (x && !x.voided) t.update('transactions', ids[i], { voided: true, voidedAt: now.time, voidedBy: u.name }); });
        audit(t, u, '作廢', o.orderNo, { 原因: reason, 作廢前: L.sums(txs.filter(Boolean)) });
        return { ...o, ...patch };
      });
    },

    async updateOrder(orderNo, p) {
      const u = seller(), f = orderFields(p);
      return store.tx(async t => {
        const o = await loadActive(t, orderNo);
        if (f.totalPrice > 0 && f.totalPrice < o.held) throw new Error(`商品總價不能低於已收訂金 ${o.held} 元`);
        const diff = {};
        Object.keys(f).forEach(k => {
          if (JSON.stringify(o[k]) !== JSON.stringify(f[k])) diff[k] = [o[k], f[k]];
        });
        if (!Object.keys(diff).length) return o;
        const patch = { ...f, updatedAt: L.twNow().time };
        patch.keys = L.searchKeys({ ...o, ...patch });
        t.update('orders', o.orderNo, patch);
        audit(t, u, '修改資料', o.orderNo, diff);
        return { ...o, ...patch };
      });
    },

    /** 會計轉記勾選：會計把這張單抄到自己的帳本後勾選。限經理與會計。 */
    async setPosted(orderNo, posted) {
      const u = bookkeeper();
      return store.tx(async t => {
        const o = await t.get('orders', String(orderNo));
        if (!o) throw new Error(`找不到訂金單 ${orderNo}`);
        t.update('orders', o.orderNo, { posted: !!posted });
        audit(t, u, posted ? '標記已轉記' : '取消轉記', o.orderNo, {});
        return { ...o, posted: !!posted };
      });
    },

    async getOrder(orderNo) {
      me();
      const order = await store.get('orders', String(orderNo));
      if (!order) throw new Error(`找不到訂金單 ${orderNo}`);
      const txs = await store.query('transactions', [['orderNo', '==', order.orderNo]]);
      txs.sort((a, b) => (a.txId < b.txId ? -1 : 1));
      return { order, txs };
    },

    /** 查詢全部訂金單（含已結案）：完整的單號／電話／末碼／姓名／發票號碼。 */
    async search(q) {
      me();
      const key = L.cleanText(q, 60).toLowerCase().replace(/\s/g, '');
      if (!key) return [];
      const rows = await store.query('orders', [['keys', 'array-contains', key]], 100);
      return rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    },

    async findCustomer(phone) {
      me();
      const p = L.cleanPhone(phone);
      if (p.length < 6) return null;
      const rows = await store.query('orders', [['phone', '==', p]], 1);
      return rows.length ? rows[0].customer : null;
    },

    /** 期間報表（日結＝起訖同一天）。 */
    async report(from, to) {
      me();
      const txs = await store.query('transactions', [['bizDate', '>=', from], ['bizDate', '<=', to]]);
      txs.sort((a, b) => (a.time < b.time ? -1 : 1));
      return { from, to, txs, ...L.summarize(txs, cfg().taxRate) };
    },

    /** 由明細重算全部訂金單，回傳不一致的清單；fix=true 時一併修正。限經理。 */
    async integrityCheck(fix) {
      needManager();
      const [orders, txs] = await Promise.all([store.query('orders'), store.query('transactions')]);
      const byOrder = new Map();
      txs.forEach(x => { if (!byOrder.has(x.orderNo)) byOrder.set(x.orderNo, []); byOrder.get(x.orderNo).push(x); });
      const bad = [];
      for (const o of orders) {
        const s = L.sums(byOrder.get(o.orderNo) || []);
        const want = { deposit: s.deposit, tail: s.tail, refunded: s.refunded, forfeited: s.forfeited,
          held: o.status === 'active' ? s.netDeposit : 0 };
        const keys = Object.keys(want).filter(k => o[k] !== want[k]);
        if (!keys.length) continue;
        bad.push({ orderNo: o.orderNo, fields: keys.map(k => `${k}: ${o[k]} → ${want[k]}`) });
        if (fix) await store.tx(async t => { t.update('orders', o.orderNo, want); });
      }
      return bad;
    },

    /** 總表：依受注日區間列出訂金單（含已結案）。 */
    async listOrders(from, to) {
      me();
      const rows = await store.query('orders', [['bizDate', '>=', L.cleanDate(from, '開始')], ['bizDate', '<=', L.cleanDate(to, '結束')]]);
      return rows.sort((a, b) => (a.orderNo < b.orderNo ? 1 : -1));
    },

    async exportAll() {
      bookkeeper();
      const [orders, txs] = await Promise.all([store.query('orders'), store.query('transactions')]);
      orders.sort((a, b) => (a.orderNo < b.orderNo ? -1 : 1));
      txs.sort((a, b) => (a.txId < b.txId ? -1 : 1));
      return { orders, txs };
    },

    async saveSettings(p) {
      needManager();
      const list = v => [...new Set(String(v || '').split(/[,，、\n]/).map(s => L.cleanText(s, 30)).filter(Boolean))];
      const s = { ...cfg(), shopName: L.cleanText(p.shopName, 40) || cfg().shopName,
        methods: list(p.methods), sources: list(p.sources),
        holdDays: L.toInt(p.holdDays, '保留天數', { allowZero: true }), terms: L.cleanText(p.terms, 400), useInvoice: !!p.useInvoice };
      if (!s.methods.length) throw new Error('至少要有一種支付方式');
      await store.set('settings', 'main', s);
      return s;
    },

    async listStaff() { needManager(); return store.query('staff'); },

    async saveStaff(uid, p) {
      const u = needManager(), name = L.cleanText(p.name, 30);
      if (!name) throw new Error('請輸入姓名');
      if (!L.ROLE_LABEL[p.role]) throw new Error('請選擇角色');
      if (uid === u.uid && (p.role !== 'manager' || !p.active)) throw new Error('不能停用自己或取消自己的經理權限');
      const doc = { uid, name, email: L.cleanText(p.email, 80), role: p.role, active: !!p.active };
      await store.set('staff', uid, doc);
      return doc;
    }
  };
}
