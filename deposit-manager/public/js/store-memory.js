// 記憶體版資料庫：示範模式與自動測試使用，介面與 store-firebase.js 相同。

function matches(doc, [field, op, value]) {
  const v = doc[field];
  if (op === '==') return v === value;
  if (op === '>=') return v >= value;
  if (op === '<=') return v <= value;
  if (op === 'array-contains') return Array.isArray(v) && v.includes(value);
  throw new Error('不支援的查詢條件：' + op);
}
const clone = v => JSON.parse(JSON.stringify(v));

export function createMemoryStore({ load, save } = {}) {
  let data = (load && load()) || {};
  const listeners = new Set();
  let autoId = 0;
  let queue = Promise.resolve(); // 交易依序執行，模擬資料庫的交易隔離
  const col = (d, name) => d[name] || (d[name] = {});
  const runQuery = (name, conds, max) => {
    let rows = Object.values(col(data, name)).filter(doc => conds.every(c => matches(doc, c)));
    if (max) rows = rows.slice(0, max);
    return clone(rows);
  };
  const commit = next => {
    data = next;
    if (save) save(data);
    listeners.forEach(l => l.cb(runQuery(l.name, l.conds)));
  };

  return {
    demo: true,
    serverTime: () => new Date().toISOString(),
    async get(name, id) { const d = col(data, name)[id]; return d ? clone(d) : null; },
    async query(name, conds = [], max = 0) { return runQuery(name, conds, max); },
    listen(name, conds, cb) {
      const l = { name, conds, cb };
      listeners.add(l);
      Promise.resolve().then(() => cb(runQuery(name, conds)));
      return () => listeners.delete(l);
    },
    /** 交易：fn 內的寫入全部成功才生效。與 Firestore 相同，讀取必須在寫入之前。 */
    tx(fn) {
      const run = queue.then(() => this._tx(fn));
      queue = run.catch(() => {});
      return run;
    },
    async _tx(fn) {
      const draft = clone(data);
      let wrote = false;
      const t = {
        async get(name, id) {
          if (wrote) throw new Error('交易內的讀取必須在寫入之前');
          const d = col(draft, name)[id]; return d ? clone(d) : null;
        },
        set(name, id, doc) { wrote = true; col(draft, name)[id] = clone(doc); },
        update(name, id, patch) {
          wrote = true;
          if (!col(draft, name)[id]) throw new Error(`文件不存在：${name}/${id}`);
          Object.assign(col(draft, name)[id], clone(patch));
        },
        add(name, doc) { wrote = true; col(draft, name)['auto' + Date.now() + '-' + (++autoId)] = clone(doc); }
      };
      const result = await fn(t);
      commit(draft);
      return result;
    },
    async set(name, id, doc) { const d = clone(data); col(d, name)[id] = clone(doc); commit(d); }
  };
}

/** 示範模式的登入：不驗證密碼，資料只存在這台裝置的瀏覽器。 */
export function createDemoAuth(store) {
  let cb = () => {};
  return {
    onChange(fn) { cb = fn; fn(null); },
    async signIn(email) {
      const staff = (await store.query('staff')).find(s => s.email === email);
      if (!staff) throw new Error('示範模式請點選下方的示範帳號');
      cb({ uid: staff.uid, email });
    },
    async signOut() { cb(null); },
    async createUser(email) { return 'demo-' + email.replace(/[^a-z0-9]/gi, ''); }
  };
}
