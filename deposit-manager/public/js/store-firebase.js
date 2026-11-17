// Firebase 版資料庫與登入，介面與 store-memory.js 相同。
const BASE = 'https://www.gstatic.com/firebasejs/10.12.2/';

const MESSAGES = {
  'auth/invalid-credential': '帳號或密碼不正確',
  'auth/wrong-password': '帳號或密碼不正確',
  'auth/user-not-found': '帳號或密碼不正確',
  'auth/invalid-email': 'Email 格式不正確',
  'auth/user-disabled': '這個帳號已被停用',
  'auth/too-many-requests': '嘗試次數過多，請稍後再試',
  'auth/email-already-in-use': '這個 Email 已經建立過帳號',
  'auth/weak-password': '密碼至少要 6 個字',
  'auth/network-request-failed': '網路連線失敗，請確認網路後再試',
  'permission-denied': '沒有權限執行這個操作',
  'unavailable': '網路連線失敗，請確認網路後再試',
  'aborted': '同時有其他人在操作，請再按一次'
};

/** 把 Firebase 的英文錯誤轉成看得懂的中文。 */
function friendly(e) {
  const msg = e && e.code && MESSAGES[e.code];
  return msg ? new Error(msg) : e;
}
const wrap = p => p.catch(e => { throw friendly(e); });

export async function createFirebase(config) {
  const [appMod, fs, au] = await Promise.all([
    import(BASE + 'firebase-app.js'), import(BASE + 'firebase-firestore.js'), import(BASE + 'firebase-auth.js')]);
  const app = appMod.initializeApp(config);
  const db = fs.getFirestore(app), auth = au.getAuth(app);
  const build = (name, conds, max) => fs.query(fs.collection(db, name),
    ...conds.map(c => fs.where(c[0], c[1], c[2])), ...(max ? [fs.limit(max)] : []));
  const rows = snap => snap.docs.map(d => d.data());

  const store = {
    demo: false,
    serverTime: () => fs.serverTimestamp(),
    get: (name, id) => wrap(fs.getDoc(fs.doc(db, name, id)).then(s => (s.exists() ? s.data() : null))),
    query: (name, conds = [], max = 0) => wrap(fs.getDocs(build(name, conds, max)).then(rows)),
    listen: (name, conds, cb, onError) => fs.onSnapshot(build(name, conds), s => cb(rows(s)), e => onError && onError(friendly(e))),
    tx: fn => wrap(fs.runTransaction(db, async tr => fn({
      get: async (name, id) => { const s = await tr.get(fs.doc(db, name, id)); return s.exists() ? s.data() : null; },
      set: (name, id, data) => { tr.set(fs.doc(db, name, id), data); },
      update: (name, id, patch) => { tr.update(fs.doc(db, name, id), patch); },
      add: (name, data) => { tr.set(fs.doc(fs.collection(db, name)), data); }
    }))),
    set: (name, id, data) => wrap(fs.setDoc(fs.doc(db, name, id), data))
  };

  const authApi = {
    onChange: cb => au.onAuthStateChanged(auth, u => cb(u ? { uid: u.uid, email: u.email } : null)),
    signIn: (email, password) => wrap(au.signInWithEmailAndPassword(auth, email, password)),
    signOut: () => au.signOut(auth),
    resetPassword: email => wrap(au.sendPasswordResetEmail(auth, email)),
    /** 經理替新人員建立帳號。使用第二個連線，不會把經理自己登出。 */
    async createUser(email, password) {
      const second = appMod.initializeApp(config, 'create-' + Date.now());
      try {
        const cred = await wrap(au.createUserWithEmailAndPassword(au.getAuth(second), email, password));
        await au.signOut(au.getAuth(second));
        return cred.user.uid;
      } finally { await appMod.deleteApp(second); }
    }
  };
  return { store, auth: authApi };
}
