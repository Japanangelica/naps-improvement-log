'use strict';

const $ = (id) => document.getElementById(id);
const video = $('video');

const state = {
  facingMode: 'environment',
  filter: 'none',
  timer: 0,           // 0 / 3 / 10 秒
  stream: null,
  busy: false,
};

/* ---------- IndexedDB 照片儲存 ---------- */
const db = {
  _db: null,
  async open() {
    if (this._db) return this._db;
    this._db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('photo-app', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('photos', { keyPath: 'id', autoIncrement: true });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this._db;
  },
  async tx(mode, fn) {
    const d = await this.open();
    return new Promise((resolve, reject) => {
      const t = d.transaction('photos', mode);
      const req = fn(t.objectStore('photos'));
      t.oncomplete = () => resolve(req && req.result);
      t.onerror = () => reject(t.error);
    });
  },
  add(photo) { return this.tx('readwrite', (s) => s.add(photo)); },
  all() { return this.tx('readonly', (s) => s.getAll()); },
  remove(id) { return this.tx('readwrite', (s) => s.delete(id)); },
};

/* ---------- 相機 ---------- */
async function startCamera() {
  stopCamera();
  $('error').classList.add('hidden');
  if (!navigator.mediaDevices?.getUserMedia) {
    return showError('此瀏覽器不支援相機。請使用 HTTPS 網址開啟，並使用最新版 Chrome / Safari。');
  }
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: state.facingMode, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    video.srcObject = state.stream;
    video.classList.toggle('mirror', state.facingMode === 'user');
  } catch (err) {
    showError(err.name === 'NotAllowedError'
      ? '無法使用相機：請在瀏覽器設定中允許相機權限後重新整理。'
      : `無法啟動相機（${err.name}）`);
  }
}

function stopCamera() {
  state.stream?.getTracks().forEach((t) => t.stop());
  state.stream = null;
}

function showError(msg) {
  $('error').textContent = msg;
  $('error').classList.remove('hidden');
}

/* ---------- 拍照 ---------- */
async function takePhoto() {
  if (state.busy || !state.stream || !video.videoWidth) return;
  state.busy = true;
  try {
    for (let n = state.timer; n > 0; n--) {
      $('countdown').textContent = n;
      $('countdown').classList.remove('hidden');
      await new Promise((r) => setTimeout(r, 1000));
    }
    $('countdown').classList.add('hidden');

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.filter = state.filter;
    if (state.facingMode === 'user') {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0);

    flash();
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
    await db.add({ blob, createdAt: Date.now() });
    await refreshThumb();
  } finally {
    state.busy = false;
  }
}

function flash() {
  const f = $('flash');
  f.classList.add('on');
  requestAnimationFrame(() => requestAnimationFrame(() => f.classList.remove('on')));
}

/* ---------- 相簿 ---------- */
const objectUrls = [];
function toUrl(blob) {
  const url = URL.createObjectURL(blob);
  objectUrls.push(url);
  return url;
}
function revokeUrls() {
  objectUrls.splice(0).forEach((u) => URL.revokeObjectURL(u));
}

async function refreshThumb() {
  const photos = await db.all();
  const last = photos[photos.length - 1];
  const img = $('last-thumb');
  if (img.src) URL.revokeObjectURL(img.src);
  if (last) img.src = URL.createObjectURL(last.blob);
  else img.removeAttribute('src');
}

async function renderGallery() {
  revokeUrls();
  const photos = (await db.all()).reverse();
  const g = $('gallery');
  g.innerHTML = '';
  $('count').textContent = photos.length ? `(${photos.length})` : '';
  $('empty').classList.toggle('hidden', photos.length > 0);
  for (const p of photos) {
    const img = document.createElement('img');
    img.src = toUrl(p.blob);
    img.loading = 'lazy';
    img.alt = new Date(p.createdAt).toLocaleString('zh-TW');
    img.onclick = () => openViewer(p, img.src);
    g.appendChild(img);
  }
}

let current = null;
function openViewer(photo, url) {
  current = photo;
  $('viewer-img').src = url;
  $('btn-share').classList.toggle('hidden', !navigator.canShare);
  $('viewer').showModal();
}

function fileName(p) {
  const d = new Date(p.createdAt);
  const pad = (n) => String(n).padStart(2, '0');
  return `IMG_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.jpg`;
}

function showView(name) {
  const toGallery = name === 'gallery';
  $('camera-view').classList.toggle('hidden', toGallery);
  $('gallery-view').classList.toggle('hidden', !toGallery);
  if (toGallery) { stopCamera(); renderGallery(); }
  else { revokeUrls(); startCamera(); }
}

/* ---------- 事件 ---------- */
$('btn-shutter').onclick = takePhoto;
$('btn-switch').onclick = () => {
  state.facingMode = state.facingMode === 'user' ? 'environment' : 'user';
  startCamera();
};
$('btn-grid').onclick = (e) => {
  $('grid').classList.toggle('hidden');
  e.currentTarget.classList.toggle('on');
};
$('btn-timer').onclick = (e) => {
  const next = { 0: 3, 3: 10, 10: 0 }[state.timer];
  state.timer = next;
  $('timer-label').textContent = next ? `${next}秒` : '關';
  e.currentTarget.classList.toggle('on', next > 0);
};
$('filters').onclick = (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  document.querySelectorAll('#filters button').forEach((b) => b.classList.toggle('active', b === btn));
  state.filter = btn.dataset.filter;
  video.style.filter = state.filter === 'none' ? '' : state.filter;
};
$('btn-gallery').onclick = () => showView('gallery');
$('btn-back').onclick = () => showView('camera');

$('btn-close').onclick = () => $('viewer').close();
$('btn-download').onclick = () => {
  const a = document.createElement('a');
  a.href = $('viewer-img').src;
  a.download = fileName(current);
  a.click();
};
$('btn-share').onclick = async () => {
  const file = new File([current.blob], fileName(current), { type: 'image/jpeg' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); } catch { /* 使用者取消 */ }
  } else {
    alert('此裝置不支援分享照片，請改用下載。');
  }
};
$('btn-delete').onclick = async () => {
  if (!confirm('確定要刪除這張照片嗎？')) return;
  await db.remove(current.id);
  $('viewer').close();
  renderGallery();
  refreshThumb();
};

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !$('camera-view').classList.contains('hidden')) {
    e.preventDefault();
    takePhoto();
  }
});
document.addEventListener('visibilitychange', () => {
  if ($('camera-view').classList.contains('hidden')) return;
  if (document.hidden) stopCamera(); else startCamera();
});

/* ---------- 啟動 ---------- */
startCamera();
refreshThumb();
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
