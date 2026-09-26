'use strict';

const $ = (id) => document.getElementById(id);
const video = $('video');

const state = {
  facingMode: 'environment',
  filter: 'none',
  timer: 0,           // 0 / 3 / 10 秒
  burst: false,       // 連拍 5 張
  hints: true,
  stream: null,
  capturing: false,  // 倒數與拍攝期間（不含背景美化）
  track: null,
  caps: {},          // 目前鏡頭支援的功能（變焦、補光燈、對焦…）
  backCams: [],      // 三星等多鏡頭手機的後鏡頭清單（超廣角、主鏡頭、望遠）
  backIndex: 0,
  zoom: 1,
  torch: false,
  wakeLock: null,
  auto: false,       // 自動快門
  ratio: null,       // 畫面比例（寬/高）：null = 原始
  settings: {},      // 目前鏡頭的實際解析度等設定
};

const RATIO_NAMES = [[3 / 4, '3:4'], [4 / 3, '4:3'], [9 / 16, '9:16'], [16 / 9, '16:9'], [1, '1:1']];
const RATIO_CHOICES = [null, 3 / 4, 9 / 16, 1];

function ratioLabel(r) {
  const found = RATIO_NAMES.find(([v]) => Math.abs(v - r) / v < 0.02);
  return found ? found[1] : '原始';
}
const nativeRatio = () => video.videoWidth / video.videoHeight;
/** 可選的比例：原始比例，加上與原始不同的 3:4、9:16、1:1 */
function ratioOptions() {
  const n = nativeRatio();
  return RATIO_CHOICES.filter((v) => v === null || !n || Math.abs(v - n) / v >= 0.02);
}
function updateRatioLabel() {
  $('btn-ratio').textContent = ratioLabel(state.ratio ?? nativeRatio());
}

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
  put(photo) { return this.tx('readwrite', (s) => s.put(photo)); },
  remove(id) { return this.tx('readwrite', (s) => s.delete(id)); },
};

/* ---------- 相機 ---------- */
async function startCamera() {
  stopCamera();
  $('error').classList.add('hidden');
  if (!navigator.mediaDevices?.getUserMedia) {
    return showError('此瀏覽器不支援相機。請使用 HTTPS 網址開啟，並使用最新版 Chrome / Safari。');
  }
  const back = state.facingMode === 'environment' && state.backCams[state.backIndex];
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        ...(back ? { deviceId: { exact: back.deviceId } } : { facingMode: state.facingMode }),
        // 三星相機預設 4:3，要求較高解析度，實際會取最接近的支援規格
        // S24 Ultra 等高階機可提供到 4000×3000（1200 萬畫素）
        width: { ideal: 4000 },
        height: { ideal: 3000 },
      },
      audio: false,
    });
    video.srcObject = state.stream;
    video.classList.toggle('mirror', state.facingMode === 'user');
    state.track = state.stream.getVideoTracks()[0];
    state.caps = state.track.getCapabilities?.() ?? {};
    state.settings = state.track.getSettings?.() ?? {};
    state.zoom = 1;
    state.torch = false;
    await listBackCameras();
    updateCameraControls();
    requestWakeLock();
  } catch (err) {
    showError(err.name === 'NotAllowedError'
      ? '無法使用相機：請在瀏覽器設定中允許相機權限後重新整理。'
      : `無法啟動相機（${err.name}）`);
  }
}

function stopCamera() {
  state.stream?.getTracks().forEach((t) => t.stop());
  state.stream = null;
  state.track = null;
  state.wakeLock?.release().catch(() => {});
  state.wakeLock = null;
}

/* ---------- 三星（Android）鏡頭控制 ---------- */
async function listBackCameras() {
  if (state.backCams.length || state.facingMode !== 'environment') return;
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  // Android Chrome 的標籤類似「camera2 0, facing back」
  state.backCams = devices.filter((d) => d.kind === 'videoinput' && /back|rear|environment|後/i.test(d.label));
  const current = state.track.getSettings().deviceId;
  state.backIndex = Math.max(0, state.backCams.findIndex((d) => d.deviceId === current));
}

function applyAdvanced(constraints) {
  return state.track?.applyConstraints({ advanced: [constraints] }).catch((err) => console.warn(err));
}

function updateCameraControls() {
  const { zoom, torch } = state.caps;
  $('btn-torch').classList.toggle('hidden', !torch);
  $('btn-torch').classList.remove('on');

  const lensBtn = $('btn-lens');
  const multiLens = state.facingMode === 'environment' && state.backCams.length > 1;
  lensBtn.classList.toggle('hidden', !multiLens);
  lensBtn.textContent = `鏡頭 ${state.backIndex + 1}/${state.backCams.length}`;

  // 對齊三星相機的變焦段位：0.6x 超廣角、1x、2x、3x／5x 望遠、10x
  const levels = zoom ? [zoom.min, 1, 2, 3, 5, 10].filter((z, i, a) => z >= zoom.min && z <= zoom.max && a.indexOf(z) === i) : [];
  const box = $('zoom-levels');
  box.innerHTML = '';
  if (levels.length > 1) {
    for (const z of levels) {
      const b = document.createElement('button');
      b.dataset.zoom = z;
      b.textContent = `${Number(z.toFixed(1))}x`;
      b.onclick = () => setZoom(z);
      box.appendChild(b);
    }
  }
  $('lens-bar').classList.toggle('hidden', !multiLens && levels.length < 2);
  markZoom();
}

function setZoom(z) {
  const { zoom } = state.caps;
  if (!zoom) return;
  state.zoom = Math.min(zoom.max, Math.max(zoom.min, z));
  applyAdvanced({ zoom: state.zoom });
  markZoom();
}

function markZoom() {
  document.querySelectorAll('#zoom-levels button').forEach((b) => {
    b.classList.toggle('active', Math.abs(Number(b.dataset.zoom) - state.zoom) < 0.05);
  });
}

async function requestWakeLock() {
  // 拍照時螢幕不自動變暗、鎖定
  try { state.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* 省電模式等情況 */ }
}

/** 點畫面對焦：把點擊位置換算成影像座標（0–1） */
function focusAt(clientX, clientY) {
  const { focusMode = [], pointsOfInterest } = state.caps;
  if (!state.track || (!focusMode.length && !pointsOfInterest)) return;
  const r = $('frame').getBoundingClientRect();
  let fx = (clientX - r.left) / r.width;
  const fy = (clientY - r.top) / r.height;
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return;
  if (state.facingMode === 'user') fx = 1 - fx;
  const c0 = currentCrop();
  const x = (c0.sx + fx * c0.sw) / video.videoWidth;
  const y = (c0.sy + fy * c0.sh) / video.videoHeight;

  const c = { pointsOfInterest: [{ x, y }] };
  if (focusMode.includes('single-shot')) c.focusMode = 'single-shot';
  else if (focusMode.includes('continuous')) c.focusMode = 'continuous';
  applyAdvanced(c);

  const ring = $('focus-ring');
  ring.style.left = `${clientX - $('viewfinder').getBoundingClientRect().left}px`;
  ring.style.top = `${clientY - $('viewfinder').getBoundingClientRect().top}px`;
  ring.classList.remove('show');
  void ring.offsetWidth;
  ring.classList.add('show');
}

function showError(msg) {
  $('error').textContent = msg;
  $('error').classList.remove('hidden');
}

/* ---------- 拍照 ---------- */
/*
 * 拍照：按下快門立刻震動、閃白、縮圖更新，馬上可以拍下一張；
 * AI 分析與美化排隊在背景處理，不會卡住相機。
 */
async function takePhoto() {
  if (state.capturing || !state.stream || !video.videoWidth) return;
  state.capturing = true;
  pressFeedback();
  try {
    for (let n = state.timer; n > 0; n--) {
      $('countdown').textContent = n;
      $('countdown').classList.remove('hidden');
      await new Promise((r) => setTimeout(r, 1000));
    }
    $('countdown').classList.add('hidden');

    const shots = state.burst ? 5 : 1;
    const frames = [];
    for (let i = 0; i < shots; i++) {
      if (i) await new Promise((r) => setTimeout(r, 200));
      const f = capture();
      frames.push(f);
      flash();
      showQuickThumb(f.canvas);
    }
    enqueue(frames);
  } finally {
    state.capturing = false;
  }
}

/** 按下快門的即時回饋：按鈕縮一下＋震動 */
function pressFeedback() {
  navigator.vibrate?.(20);
  const b = $('btn-shutter');
  b.classList.remove('pressed');
  void b.offsetWidth;
  b.classList.add('pressed');
}

/** 拍下的瞬間就把縮圖換成這張（美化完成後再換成美化版） */
function showQuickThumb(canvas) {
  const t = document.createElement('canvas');
  t.width = 96;
  t.height = Math.round(96 * canvas.height / canvas.width);
  t.getContext('2d').drawImage(canvas, 0, 0, t.width, t.height);
  const img = $('last-thumb');
  if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
  img.src = t.toDataURL('image/jpeg', 0.7);
  const btn = $('btn-gallery');
  btn.classList.remove('pop');
  void btn.offsetWidth;
  btn.classList.add('pop');
}

/* 背景處理佇列 */
const queue = [];
let processing = false;
const idle = () => new Promise((r) => (window.requestIdleCallback ? requestIdleCallback(() => r(), { timeout: 400 }) : setTimeout(r, 30)));

function updateQueueBadge() {
  const n = queue.reduce((sum, job) => sum + job.length, 0) + (processing ? 1 : 0);
  $('queue-badge').textContent = n ? `美化中 ${n}` : '';
  $('queue-badge').classList.toggle('hidden', !n);
  $('import-status').textContent = n ? `✨ 修圖中，還有 ${n} 張…（可以先看已完成的照片）` : '';
  $('import-status').classList.toggle('hidden', !n);
}

/* ---------- 從相簿匯入（用三星相機拍，再到這裡修圖） ---------- */
const IMPORT_MAX_SIDE = 4000;   // 5000 萬、2 億畫素模式的照片縮到最長邊 4000，避免記憶體不足
const BEST_PICK_MAX = 20;       // 一次選 2～20 張時，當作一組連拍挑最佳

function importJob(file) {
  return {
    extra: { createdAt: file.lastModified || Date.now(), imported: true, sourceName: file.name },
    async load() {
      // from-image：依照片裡記錄的方向轉正（三星直拍的照片方向存在 EXIF）
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const k = Math.min(1, IMPORT_MAX_SIDE / Math.max(bmp.width, bmp.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bmp.width * k);
      canvas.height = Math.round(bmp.height * k);
      canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
      bmp.close();
      return { canvas, level: 'tip' };
    },
  };
}

function importFiles(fileList) {
  const files = [...fileList].filter((f) => f.type.startsWith('image/'));
  if (!files.length) return;
  const jobs = files.map(importJob);
  if (jobs.length >= 2 && jobs.length <= BEST_PICK_MAX) queue.push(jobs); // 一組，會挑最佳
  else jobs.forEach((j) => queue.push([j]));
  updateQueueBadge();
  if (!processing) runQueue();
}

$('import-input').addEventListener('change', (e) => {
  importFiles(e.target.files);
  e.target.value = ''; // 同一批照片可以再選一次
});

let lastShot = 0;
function enqueue(frames) {
  queue.push(frames);
  lastShot = performance.now();
  updateQueueBadge();
  if (!processing) runQueue();
}

/** 等到停止拍照 1.2 秒再開始 AI 分析，連續拍照時完全不受影響 */
async function waitForPause() {
  while (performance.now() - lastShot < 1200 || state.capturing) {
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function runQueue() {
  processing = true;
  while (queue.length) {
    const frames = queue.shift();
    const saved = [];
    try {
      while (frames.length) {
        updateQueueBadge();
        const job = frames.shift();
        if (job.load) {
          // 匯入的照片：輪到它時才讀檔，避免一次把很多張大照片放進記憶體
          const frame = await job.load().catch((err) => { console.warn('無法讀取照片', err); return null; });
          if (frame) saved.push(await savePhoto(frame, job.extra));
        } else {
          await waitForPause();
          saved.push(await savePhoto(job));
        }
        if (!$('gallery-view').classList.contains('hidden')) renderGallery();
      }
      if (saved.length > 1) await markBestShot(saved);
      await refreshThumb();
      if (!$('gallery-view').classList.contains('hidden')) renderGallery();
    } catch (err) {
      console.warn('照片處理失敗', err);
    }
  }
  processing = false;
  updateQueueBadge();
}

function currentCrop() {
  return Hints.cropRect(video.videoWidth, video.videoHeight, state.ratio);
}

/** 依比例把預覽框縮放到觀景窗內（預覽範圍 = 實際拍到的範圍） */
function layoutFrame() {
  const vf = $('viewfinder'), frame = $('frame');
  const { sw, sh } = currentCrop();
  if (!sw || !sh) return;
  const scale = Math.min(vf.clientWidth / sw, vf.clientHeight / sh);
  frame.style.width = `${sw * scale}px`;
  frame.style.height = `${sh * scale}px`;
}

/** 拍下目前畫面，並記錄當下的人物位置（給自動美化用） */
function capture() {
  const crop = currentCrop();
  const { sx, sy, sw, sh } = crop;
  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext('2d');
  ctx.filter = state.filter;
  if (state.facingMode === 'user') {
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);

  // 快門這一步只擷取畫面，人物位置等分析留到背景處理
  return { canvas, level: state.lastLevel || 'tip' };
}

/**
 * 在縮小的畫面上偵測人物骨架（模型本身只需要 256px，送整張 4K 畫面反而很慢）。
 * 回傳的座標相對於 source 中 (sx, sy, sw, sh) 這塊區域。
 */
const poseCanvas = document.createElement('canvas');
const poseCtx = poseCanvas.getContext('2d');
function detectPose(source, sx, sy, sw, sh) {
  if (!poseDetector || !sw || !sh) return null;
  const k = 256 / Math.max(sw, sh);
  const w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k));
  if (poseCanvas.width !== w || poseCanvas.height !== h) { poseCanvas.width = w; poseCanvas.height = h; }
  poseCtx.drawImage(source, sx, sy, sw, sh, 0, 0, w, h);
  const ts = Math.max(performance.now(), lastPoseTs + 1);
  lastPoseTs = ts;
  return poseDetector.detectForVideo(poseCanvas, ts).landmarks?.[0] ?? null;
}

const toJpeg = (canvas) => new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.92));

/* 美化繪製交給背景執行緒；不支援時才在主畫面處理 */
let renderWorker = null;
try {
  if (typeof OffscreenCanvas !== 'undefined' && window.Worker) renderWorker = new Worker('render-worker.js');
} catch (err) { console.warn('背景執行緒無法啟動，改在主畫面處理', err); }
const pendingRenders = new Map();
let renderSeq = 0;
renderWorker?.addEventListener('message', (e) => {
  const job = pendingRenders.get(e.data.id);
  if (!job) return;
  pendingRenders.delete(e.data.id);
  if (e.data.error) job.reject(new Error(e.data.error)); else job.resolve(e.data.blob);
});

/** 依分析結果與美化程度產生美化後的 JPEG */
async function renderBeauty(source, info, params) {
  if (renderWorker) {
    const bitmap = await createImageBitmap(source);
    const id = ++renderSeq;
    return new Promise((resolve, reject) => {
      pendingRenders.set(id, { resolve, reject });
      renderWorker.postMessage({ id, bitmap, info, params }, [bitmap]);
    });
  }
  const bitmap = source instanceof Blob ? await createImageBitmap(source) : source;
  return toJpeg(Beauty.render(bitmap, bitmap.width, bitmap.height, info, params));
}

/** 存原圖＋自動美化後的照片；APK 版同時存到手機相簿 */
async function savePhoto({ canvas, level }, extra = {}) {
  const original = await toJpeg(canvas);
  const photo = { blob: original, createdAt: Date.now(), ...extra };
  // 分析一次（臉、人物分割、清晰度），之後調整美化不必重跑模型；每一步之間讓出時間給相機畫面
  const info = { level, ...(await analyzePhoto(canvas)) };
  photo.info = info;
  if (settings.beauty.on) {
    const beauty = { ...settings.beauty };
    delete beauty.on;
    try {
      photo.blob = await renderBeauty(canvas, info, beauty);
      photo.original = original;
      photo.beauty = beauty;
    } catch (err) { console.warn('美化失敗，保留原圖', err); }
  }
  photo.id = await db.add(photo);
  if (isNative && settings.autosave && Native.Gallery) {
    try { await saveToPhoneGallery(photo); } catch (err) { console.warn('存到手機相簿失敗', err); }
  }
  return photo;
}

/** 連拍：挑出最佳一張並標記 */
async function markBestShot(photos) {
  const best = Beauty.pickBest(photos.map((p) => p.info));
  const burstId = photos[0].createdAt;
  for (const [i, p] of photos.entries()) {
    p.burstId = burstId;
    if (i === best) p.best = Beauty.bestReason(p.info);
    await db.put(p);
  }
  showToast(`👑 已從 ${photos.length} 張中挑出最佳一張：${photos[best].best}`);
  if (!$('gallery-view').classList.contains('hidden')) {
    $('import-status').textContent = `👑 已從 ${photos.length} 張中挑出最佳一張（標有皇冠）`;
    $('import-status').classList.remove('hidden');
    setTimeout(updateQueueBadge, 4000);
  }
}

let toastTimer;
function showToast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
}

function flash() {
  navigator.vibrate?.(30);
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

/* 相簿：依日期分組、多選刪除／分享 */
let galleryList = [];           // 目前相簿顯示的照片（新到舊），檢視時左右滑動用
const selected = new Set();
let selecting = false;

function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 86400000);
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  const week = '日一二三四五六'[d.getDay()];
  const md = `${d.getMonth() + 1}月${d.getDate()}日（${week}）`;
  return d.getFullYear() === today.getFullYear() ? md : `${d.getFullYear()}年${md}`;
}

function formatMB(bytes) {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(0.1, bytes / 1e6).toFixed(1)} MB`;
}

async function renderGallery() {
  revokeUrls();
  galleryList = (await db.all()).sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
  const g = $('gallery');
  g.innerHTML = '';
  g.classList.toggle('selecting', selecting);
  $('count').textContent = galleryList.length ? `(${galleryList.length})` : '';
  $('empty').classList.toggle('hidden', galleryList.length > 0);
  g.classList.toggle('hidden', galleryList.length === 0);
  $('btn-select').classList.toggle('hidden', galleryList.length === 0 && !selecting);
  $('storage-info').classList.toggle('hidden', galleryList.length === 0);

  const bytes = galleryList.reduce((n, p) => n + (p.blob?.size || 0) + (p.original?.size || 0), 0);
  const saved = galleryList.filter((p) => p.galleryUri).length;
  $('storage-info').textContent = galleryList.length
    ? `共 ${galleryList.length} 張 · App 內佔用約 ${formatMB(bytes)}` +
      (isNative ? ` · ${saved} 張已存到手機相簿「拍照App」` : '')
    : '';

  let tiles = null, lastDay = null;
  for (const p of galleryList) {
    const day = dayLabel(p.createdAt);
    if (day !== lastDay) {
      const count = galleryList.filter((x) => dayLabel(x.createdAt) === day).length;
      const h = document.createElement('h3');
      h.className = 'day';
      h.innerHTML = `${day}<small>${count} 張</small>`;
      tiles = document.createElement('div');
      tiles.className = 'tiles';
      g.append(h, tiles);
      lastDay = day;
    }
    const tile = document.createElement('button');
    tile.className = 'tile' + (selected.has(p.id) ? ' selected' : '');
    tile.setAttribute('aria-label', new Date(p.createdAt).toLocaleString('zh-TW'));
    const img = document.createElement('img');
    img.src = toUrl(p.blob);
    img.loading = 'lazy';
    img.alt = '';
    const badges = document.createElement('span');
    badges.className = 'badges';
    if (p.best) badges.insertAdjacentHTML('beforeend', '<span title="推薦">👑</span>');
    if (p.imported) badges.insertAdjacentHTML('beforeend', '<span title="從相簿匯入">匯入</span>');
    if (p.original) badges.insertAdjacentHTML('beforeend', '<span title="已美化">✨</span>');
    if (p.galleryUri) badges.insertAdjacentHTML('beforeend', '<span title="已存到手機相簿">✓相簿</span>');
    const check = document.createElement('span');
    check.className = 'check';
    tile.append(img, badges, check);
    tile.onclick = () => {
      if (selecting) {
        if (selected.has(p.id)) selected.delete(p.id); else selected.add(p.id);
        tile.classList.toggle('selected', selected.has(p.id));
        updateSelectBar();
      } else {
        openViewer(p, img.src);
      }
    };
    tiles.appendChild(tile);
  }
  updateSelectBar();
}

function setSelecting(on) {
  selecting = on;
  selected.clear();
  $('btn-select').textContent = on ? '取消' : '選取';
  $('select-bar').classList.toggle('hidden', !on);
  renderGallery();
}

function updateSelectBar() {
  $('select-count').textContent = `已選 ${selected.size} 張`;
  $('btn-select-share').disabled = selected.size === 0;
  $('btn-select-delete').disabled = selected.size === 0;
}

$('btn-select').onclick = () => setSelecting(!selecting);
$('btn-select-share').onclick = async () => {
  const photos = galleryList.filter((p) => selected.has(p.id));
  try { await shareFiles(photos); } catch { /* 使用者取消 */ }
};
$('btn-select-delete').onclick = async () => {
  const photos = galleryList.filter((p) => selected.has(p.id));
  if (!(await deletePhotos(photos))) return;
  setSelecting(false);
  refreshThumb();
};

let current = null;
let viewerUrls = {};
function openViewer(photo, url) {
  current = photo;
  Object.values(viewerUrls).forEach((u) => URL.revokeObjectURL(u));
  viewerUrls = {};
  $('viewer-img').src = url;
  setupRetouchPanel(photo);
  updateViewerMeta();
  $('btn-share').classList.toggle('hidden', !navigator.canShare && !isNative);
  $('viewer').showModal();
}

function updateViewerMeta() {
  const i = galleryList.findIndex((p) => p.id === current?.id);
  $('viewer-pos').textContent = i >= 0 ? `${i + 1} / ${galleryList.length}` : '';
  $('viewer-saved').textContent = current?.galleryUri ? '✓ 已存到手機相簿' : '';
  $('btn-download').textContent = isNative ? (current?.galleryUri ? '重新存到相簿' : '存到相簿') : '下載';
}

/** 左右滑動切換照片 */
function stepViewer(dir) {
  const i = galleryList.findIndex((p) => p.id === current?.id);
  const next = galleryList[i + dir];
  if (!next) return;
  openViewer(next, toUrl(next.blob));
}

/* ---------- 美化面板：原圖／美化對照、長腿程度 ---------- */
/* 美化面板：選一個項目、用滑桿調整；舊版照片（只有長腿）也相容 */
const BEAUTY_LABEL = { frame: '構圖', legs: '長腿', waist: '瘦腰', face: '小臉', skin: '美肌', blur: '背景虛化' };
const BEAUTY_WHY = {
  frame: '這張沒偵測到人物的頭和身體',
  legs: '這張沒拍到完整的腰和腳',
  waist: '這張沒拍到完整的肩膀和腰',
  face: '這張沒偵測到臉',
  skin: '這張沒有清楚偵測到臉和人物範圍',
  blur: '這張沒有清楚偵測到人物範圍（背對、太遠或太暗時常發生）',
};
let beautyKey = 'frame';

function photoInfo(photo) {
  if (photo.info) return photo.info;
  return { anchors: photo.retouch?.anchors ?? null }; // 舊版照片
}
function photoBeauty(photo) {
  if (photo.beauty) return photo.beauty;
  return { frame: 0, legs: Math.round((photo.retouch?.legs ?? 0) * 100), waist: 0, face: 0, skin: 0, blur: 0 };
}

function setupRetouchPanel(photo) {
  const has = !!photo.original;
  $('retouch-panel').classList.toggle('hidden', !has);
  if (!has) return;
  const av = Beauty.available(photoInfo(photo));
  document.querySelectorAll('#beauty-tabs button').forEach((b) => { b.disabled = !av[b.dataset.key]; });
  if (!av[beautyKey]) beautyKey = Object.keys(BEAUTY_LABEL).find((k) => av[k]) || 'frame';
  selectBeauty(beautyKey);
  showBefore(false);
}

function selectBeauty(key) {
  beautyKey = key;
  document.querySelectorAll('#beauty-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.key === key));
  const av = Beauty.available(photoInfo(current));
  const val = photoBeauty(current)[key] ?? 0;
  $('beauty-label').textContent = BEAUTY_LABEL[key];
  $('beauty-slider').max = key === 'legs' ? 15 : 100;
  $('beauty-slider').value = val;
  $('beauty-slider').disabled = !av[key];
  $('beauty-value').textContent = key === 'legs' ? `+${val}%` : String(val);
  const info = photoInfo(current);
  const nobody = current.info && !info.framing && !info.face;
  const note = (current.best ? `👑 連拍推薦：${current.best}　` : '') +
    (nobody ? '這張沒偵測到人物（可能背對、太遠或太暗），只做了調亮。' : '');
  $('retouch-note').textContent = note + (av[key] ? '按住照片可看原圖' : nobody ? '' : `${BEAUTY_WHY[key]}，所以無法調整${BEAUTY_LABEL[key]}`);
}

function showBefore(before) {
  $('btn-show-before').classList.toggle('active', before);
  $('btn-show-after').classList.toggle('active', !before);
  if (!current?.original) return;
  const key = before ? 'before' : 'after';
  viewerUrls[key] ??= URL.createObjectURL(before ? current.original : current.blob);
  $('viewer-img').src = viewerUrls[key];
}

let beautyTimer;
async function applyBeauty(key, value) {
  const photo = current;
  const beauty = { ...photoBeauty(photo), [key]: value };
  photo.blob = await renderBeauty(photo.original, photoInfo(photo), beauty);
  photo.beauty = beauty;
  await db.put(photo);
  // 記住偏好，下次拍照沿用
  settings.beauty = { ...settings.beauty, [key]: value };
  saveSettings();
  applySettings();
  if (current === photo) {
    if (viewerUrls.after) URL.revokeObjectURL(viewerUrls.after);
    viewerUrls.after = null;
    showBefore(false);
  }
  if (isNative && photo.galleryUri && Native.Gallery) {
    try { await saveToPhoneGallery(photo); } catch (err) { console.warn('更新手機相簿失敗', err); }
  }
}

$('beauty-tabs').onclick = (e) => {
  const b = e.target.closest('button[data-key]');
  if (b && !b.disabled) selectBeauty(b.dataset.key);
};
$('beauty-slider').oninput = (e) => {
  const v = Number(e.target.value);
  const key = beautyKey;
  $('beauty-value').textContent = key === 'legs' ? `+${v}%` : String(v);
  clearTimeout(beautyTimer);
  beautyTimer = setTimeout(() => applyBeauty(key, v).catch((err) => console.warn(err)), 250);
};

$('btn-show-before').onclick = () => showBefore(true);
$('btn-show-after').onclick = () => showBefore(false);
// 按住照片看原圖、放開回到美化；左右滑動換下一張
let press = null;
$('viewer-img').addEventListener('pointerdown', (e) => {
  press = { x: e.clientX, y: e.clientY, comparing: false };
  press.timer = setTimeout(() => {
    if (press && current?.original) { press.comparing = true; showBefore(true); }
  }, 250);
});
$('viewer-img').addEventListener('pointermove', (e) => {
  if (press && Math.abs(e.clientX - press.x) > 12) clearTimeout(press.timer);
});
function endPress(e) {
  if (!press) return;
  clearTimeout(press.timer);
  const dx = e.clientX - press.x, dy = e.clientY - press.y;
  if (press.comparing) showBefore(false);
  else if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) stepViewer(dx < 0 ? 1 : -1);
  press = null;
}
$('viewer-img').addEventListener('pointerup', endPress);
$('viewer-img').addEventListener('pointercancel', endPress);

function fileName(p) {
  const d = new Date(p.createdAt);
  const pad = (n) => String(n).padStart(2, '0');
  return `IMG_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.jpg`;
}

function showView(name) {
  for (const v of ['camera', 'gallery', 'tips']) {
    $(`${v}-view`).classList.toggle('hidden', v !== name);
  }
  if (name === 'camera') { revokeUrls(); startCamera(); }
  else stopCamera();
  if (name === 'gallery') renderGallery();
  if (name === 'tips') renderDeviceInfo();
}

/* ---------- 構圖提示 ---------- */
const MP_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const POSE_MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

const sensor = { gravity: null, beta: null };
let poseDetector = null;
let poseStatus = 'loading'; // loading / ready / failed
let lastPoseTs = 0;

async function loadPoseDetector() {
  try {
    const vision = await import(`${MP_BASE}/vision_bundle.mjs`);
    const { FilesetResolver, PoseLandmarker } = vision;
    const fileset = await FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
    const create = (delegate) => PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: POSE_MODEL, delegate },
      runningMode: 'VIDEO',
      numPoses: 1,
    });
    poseDetector = await create('GPU').catch(() => create('CPU'));
    poseStatus = 'ready';
    // 分析改在背景執行緒；背景執行緒不能用時才在主畫面載入美化模型
    analysisReady.catch(() => loadBeautyModels(vision, fileset).catch((err) => console.warn('美化模型載入失敗', err)));
  } catch (err) {
    console.warn('人物偵測載入失敗，只使用亮度與角度提示', err);
    poseStatus = 'failed';
  }
}

/** 美肌、背景虛化、小臉、連拍挑最佳用的模型（人物偵測載入後再載，不影響開相機的速度） */
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const SEG_MODEL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite';
const beautyModels = {};

/* 拍照後的 AI 分析交給背景執行緒（analyze-worker.js） */
let analysisWorker = null;
const pendingAnalysis = new Map();
let analysisSeq = 0;
const analysisReady = new Promise((resolve, reject) => {
  try {
    analysisWorker = new Worker('analyze-worker.js');
  } catch (err) { reject(err); return; }
  analysisWorker.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'ready') resolve();
    else if (m.type === 'failed') reject(new Error(m.error));
    else if (m.type === 'result') {
      const job = pendingAnalysis.get(m.id);
      pendingAnalysis.delete(m.id);
      if (m.error) job?.reject(new Error(m.error)); else job?.resolve(m.info);
    }
  });
  analysisWorker.addEventListener('error', (e) => reject(e.error || new Error(e.message || '背景分析無法啟動')));
});
analysisReady.catch((err) => { console.warn('背景分析無法使用，改在主畫面分析', err); analysisWorker = null; });

/** 分析一張照片：優先用背景執行緒，不行才在主畫面做（會比較卡） */
async function analyzePhoto(canvas) {
  if (analysisWorker) {
    try {
      await analysisReady;
      const bitmap = await createImageBitmap(canvas);
      const id = ++analysisSeq;
      return await new Promise((resolve, reject) => {
        pendingAnalysis.set(id, { resolve, reject });
        analysisWorker.postMessage({ id, bitmap }, [bitmap]);
      });
    } catch (err) { console.warn('背景分析失敗，改在主畫面分析', err); }
  }
  await waitForPause();
  let anchors = null, framing = null;
  try {
    const lm = detectPose(canvas, 0, 0, canvas.width, canvas.height);
    anchors = Retouch.poseAnchors(lm);
    framing = Retouch.poseFraming(lm);
  } catch (err) { console.warn(err); }
  await waitForPause();
  const faceInfo = Beauty.analyze(canvas, { face: beautyModels.face });
  await waitForPause();
  const segInfo = Beauty.analyze(canvas, { segmenter: beautyModels.segmenter }, { sharpness: false });
  return { anchors, framing, ...faceInfo, mask: segInfo.mask };
}

async function loadBeautyModels({ FaceLandmarker, ImageSegmenter }, fileset) {
  const opts = (path, delegate) => ({ baseOptions: { modelAssetPath: path, delegate }, runningMode: 'IMAGE' });
  const withFallback = (make) => make('GPU').catch(() => make('CPU'));
  beautyModels.face = await withFallback((d) => FaceLandmarker.createFromOptions(fileset, {
    ...opts(FACE_MODEL, d), numFaces: 1, outputFaceBlendshapes: true,
  }));
  beautyModels.segmenter = await withFallback((d) => ImageSegmenter.createFromOptions(fileset, {
    ...opts(SEG_MODEL, d), outputCategoryMask: true, outputConfidenceMasks: false,
  }));
}

addEventListener('deviceorientation', (e) => { sensor.beta = e.beta; });
addEventListener('devicemotion', (e) => { sensor.gravity = e.accelerationIncludingGravity; });

// iOS 需要使用者點擊後才能要求感測器權限
async function requestSensorPermission() {
  for (const Ev of [window.DeviceOrientationEvent, window.DeviceMotionEvent]) {
    if (typeof Ev?.requestPermission === 'function') {
      try { await Ev.requestPermission(); } catch { /* 使用者拒絕 */ }
    }
  }
}

const lightCanvas = document.createElement('canvas');
lightCanvas.width = 48;
lightCanvas.height = 64;
const lightCtx = lightCanvas.getContext('2d', { willReadFrequently: true });

function readMotion() {
  const g = sensor.gravity;
  if (!g || g.x == null) return null;
  const portrait = Math.abs(g.y) >= Math.abs(g.x);
  // 手機幾乎平放時，歪斜角度沒有意義
  const flat = Math.abs(g.z) > 0.8 * Math.hypot(g.x, g.y, g.z);
  // 順時針歪斜角度（直拿時）：Android 直立時重力 y 為正
  const roll = !flat && portrait ? Math.atan2(-g.x * Math.sign(g.y || 1), Math.abs(g.y)) * 180 / Math.PI : null;
  return {
    tilt: flat ? 0 : Hints.tiltFromGravity(g),
    pitchDown: Hints.pitchDownFromBeta(sensor.beta, portrait),
    roll,
  };
}

const stability = new Guide.Stability({ holdMs: 1200 });
let lastLivePose = null;
let lastAutoShot = 0;

function clearGuide() {
  Guide.draw($('guide'), { hint: null });
  $('cue').classList.add('hidden');
  setAutoProgress(0);
}

function setAutoProgress(v) {
  $('btn-shutter').style.setProperty('--auto', String(v));
}

function updateHint() {
  const el = $('hint');
  const active = state.hints && state.stream && video.videoWidth && !$('camera-view').classList.contains('hidden');
  el.classList.toggle('hidden', !active);
  if (!active) { clearGuide(); return; }

  const crop = currentCrop();
  lightCtx.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, lightCanvas.width, lightCanvas.height);
  const light = Hints.measureLight(lightCtx, lightCanvas.width, lightCanvas.height);

  // 拍照瞬間與背景分析期間暫停偵測，讓快門優先
  const pose = state.capturing ? lastLivePose : detectPose(video, crop.sx, crop.sy, crop.sw, crop.sh);
  lastLivePose = pose;

  const motion = readMotion();
  let hint = Hints.analyze({ light, motion, pose });
  if (hint.text.startsWith('太暗') && state.caps.torch && !state.torch) {
    hint = { ...hint, text: `${hint.text}，或打開上方 🔦 補光燈` };
  }
  if (!pose && hint.level === 'tip' && poseStatus === 'loading') {
    hint = { level: 'tip', text: '人物偵測載入中…' };
  }
  state.lastLevel = hint.level;
  el.className = `hint ${hint.level}`;
  el.textContent = `${hint.level === 'ok' ? '✅' : hint.level === 'warn' ? '⚠️' : '💡'} ${hint.text}`;

  // 畫面導引
  Guide.draw($('guide'), { lm: pose, mirror: state.facingMode === 'user', hint, roll: motion?.roll ?? null });
  const cue = Guide.cueFor(hint.code);
  $('cue').className = cue ? `cue ${cue.dir}` : 'cue hidden';
  if (cue) $('cue').querySelector('.cue-text').textContent = cue.text;

  // 自動快門：構圖 OK 且她站穩 1.2 秒就自動拍，拍完休息 4 秒
  if (state.auto) {
    const now = performance.now();
    const ready = hint.level === 'ok' && !state.capturing && now - lastAutoShot > 4000;
    const progress = stability.update(ready, pose, now);
    setAutoProgress(progress);
    if (progress >= 1) {
      lastAutoShot = now;
      stability.reset();
      setAutoProgress(0);
      takePhoto();
    }
  } else {
    setAutoProgress(0);
  }
}

/* ---------- 事件 ---------- */
$('btn-shutter').onclick = takePhoto;
$('btn-ratio').onclick = () => {
  const opts = ratioOptions();
  state.ratio = opts[(opts.indexOf(state.ratio) + 1) % opts.length];
  updateRatioLabel();
  layoutFrame();
};
for (const ev of ['loadedmetadata', 'resize']) {
  video.addEventListener(ev, () => {
    if (!ratioOptions().includes(state.ratio)) state.ratio = null;
    updateRatioLabel();
    layoutFrame();
  });
}
addEventListener('resize', layoutFrame);

$('btn-torch').onclick = (e) => {
  state.torch = !state.torch;
  applyAdvanced({ torch: state.torch });
  e.currentTarget.classList.toggle('on', state.torch);
};
$('btn-lens').onclick = () => {
  state.backIndex = (state.backIndex + 1) % state.backCams.length;
  startCamera();
};
$('viewfinder').addEventListener('click', (e) => {
  if (e.target === video || e.target === $('frame')) focusAt(e.clientX, e.clientY);
});

// 雙指縮放
let pinch = null;
$('viewfinder').addEventListener('touchstart', (e) => {
  if (e.touches.length === 2 && state.caps.zoom) {
    const [a, b] = e.touches;
    pinch = { dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), zoom: state.zoom };
  }
}, { passive: true });
$('viewfinder').addEventListener('touchmove', (e) => {
  if (!pinch || e.touches.length !== 2) return;
  e.preventDefault();
  const [a, b] = e.touches;
  const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  setZoom(pinch.zoom * dist / pinch.dist);
}, { passive: false });
$('viewfinder').addEventListener('touchend', () => { pinch = null; });

$('btn-switch').onclick = () => {
  state.facingMode = state.facingMode === 'user' ? 'environment' : 'user';
  startCamera();
};
$('btn-timer').onclick = (e) => {
  const next = { 0: 3, 3: 10, 10: 0 }[state.timer];
  state.timer = next;
  $('timer-label').textContent = next || '';
  e.currentTarget.classList.toggle('on', next > 0);
};
$('btn-filter').onclick = () => $('filters').classList.toggle('hidden');
$('filters').onclick = (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  document.querySelectorAll('#filters button').forEach((b) => b.classList.toggle('active', b === btn));
  state.filter = btn.dataset.filter;
  video.style.filter = state.filter === 'none' ? '' : state.filter;
  $('btn-filter').classList.toggle('on', state.filter !== 'none');
};

/* ---------- 拍照模式：自動 · 拍照 · 連拍 ---------- */
function setMode(mode) {
  state.mode = mode;
  state.auto = mode === 'auto';
  state.burst = mode === 'burst';
  document.querySelectorAll('#modes button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  if (state.auto && !settings.hints) { settings.hints = true; applySettings(); } // 自動快門需要構圖提示
  stability.reset();
  saveSettings();
  updateHint();
}
$('modes').onclick = (e) => {
  const btn = e.target.closest('button[data-mode]');
  if (btn) setMode(btn.dataset.mode);
};

/* ---------- 設定 ---------- */
const settings = { hints: true, grid: false, autosave: true, mode: 'photo', beauty: { on: true, ...Beauty.DEFAULTS } };
try {
  const saved = JSON.parse(localStorage.getItem('settings') || '{}');
  // 舊版設定：beautify / legs
  if (saved.beautify != null || saved.legs != null) {
    saved.beauty = { on: saved.beautify ?? true, ...Beauty.DEFAULTS, legs: saved.legs ?? Beauty.DEFAULTS.legs };
    delete saved.beautify;
    delete saved.legs;
  }
  // v2：預設美化程度調低，舊的偏好重設一次
  if ((saved.version || 1) < 2) saved.beauty = { on: saved.beauty?.on ?? true };
  if ((saved.version || 1) < 3 && saved.beauty) saved.beauty.blur = 0; // v3：背景虛化改成預設關閉
  Object.assign(settings, saved, { version: 3 });
  settings.beauty = { on: true, ...Beauty.DEFAULTS, ...settings.beauty };
} catch { /* 無法使用瀏覽器儲存 */ }

function saveSettings() {
  settings.mode = state.mode;
  try { localStorage.setItem('settings', JSON.stringify(settings)); } catch { /* 無法使用瀏覽器儲存 */ }
}

function applySettings() {
  state.hints = settings.hints;
  $('grid').classList.toggle('hidden', !settings.grid);
  $('set-hints').checked = settings.hints;
  $('set-grid').checked = settings.grid;
  $('set-beautify').checked = settings.beauty.on;
  const b = settings.beauty;
  $('beauty-summary').textContent = `目前：構圖 ${b.frame}、長腿 +${b.legs}%、瘦腰 ${b.waist}、小臉 ${b.face}、美肌 ${b.skin}、虛化 ${b.blur}`;
  $('set-autosave').checked = settings.autosave;
  $('row-autosave').classList.toggle('hidden', !isNative);
  if (!settings.hints && state.auto) setMode('photo');
  updateHint();
}

$('btn-settings').onclick = () => $('settings').showModal();
$('btn-settings-close').onclick = () => $('settings').close();
$('settings').addEventListener('click', (e) => { if (e.target === $('settings')) $('settings').close(); }); // 點面板外面關閉
for (const [id, key] of [['set-hints', 'hints'], ['set-grid', 'grid'], ['set-autosave', 'autosave']]) {
  $(id).onchange = (e) => { settings[key] = e.target.checked; applySettings(); saveSettings(); };
}
$('set-beautify').onchange = (e) => { settings.beauty.on = e.target.checked; applySettings(); saveSettings(); };
$('btn-beauty-reset').onclick = () => {
  settings.beauty = { on: settings.beauty.on, ...Beauty.DEFAULTS };
  applySettings();
  saveSettings();
};

$('btn-gallery').onclick = () => showView('gallery');
$('btn-tips').onclick = () => { $('settings').close(); showView('tips'); };
document.querySelectorAll('.btn-back-camera').forEach((b) => { b.onclick = () => showView('camera'); });
document.addEventListener('click', requestSensorPermission, { once: true });

$('btn-close').onclick = () => { $('viewer').close(); renderGallery(); refreshThumb(); };
/* ---------- APK（Capacitor）原生功能 ---------- */
const isNative = !!window.Capacitor?.isNativePlatform?.();
const Native = window.Capacitor?.Plugins ?? {};

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** 存到（或更新）手機相簿「Pictures/拍照App」，回傳相簿裡的 uri */
async function saveToPhoneGallery(photo) {
  const { uri } = await Native.Gallery.save({
    data: await blobToBase64(photo.blob),
    fileName: fileName(photo),
    ...(photo.galleryUri ? { uri: photo.galleryUri } : {}),
  });
  photo.galleryUri = uri;
  await db.put(photo);
  return uri;
}

async function shareFiles(photos) {
  if (isNative) {
    const files = [];
    for (const p of photos) {
      const { uri } = await Native.Filesystem.writeFile({
        path: fileName(p), data: await blobToBase64(p.blob), directory: 'CACHE',
      });
      files.push(uri);
    }
    await Native.Share.share({ files, dialogTitle: '分享照片' });
    return;
  }
  const files = photos.map((p) => new File([p.blob], fileName(p), { type: 'image/jpeg' }));
  if (navigator.canShare?.({ files })) await navigator.share({ files });
  else alert('此裝置不支援分享照片，請改用「存到相簿」。');
}

async function deletePhotos(photos) {
  const n = photos.length;
  const msg = isNative
    ? `刪除 App 裡的 ${n} 張照片？\n（已存到手機相簿的照片不會被刪除）`
    : `確定要刪除 ${n} 張照片嗎？`;
  if (!confirm(msg)) return false;
  for (const p of photos) await db.remove(p.id);
  return true;
}

$('btn-download').onclick = async () => {
  if (isNative) {
    try {
      await saveToPhoneGallery(current);
      updateViewerMeta();
      alert('已存到手機相簿「拍照App」');
    } catch (err) { alert(`儲存失敗：${err.message}`); }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(current.blob);
  a.download = fileName(current);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('btn-share').onclick = async () => {
  try { await shareFiles([current]); } catch { /* 使用者取消 */ }
};
$('btn-delete').onclick = async () => {
  if (!(await deletePhotos([current]))) return;
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

/* ---------- 相機資訊（協助針對機型調整） ---------- */
async function renderDeviceInfo() {
  const devices = await navigator.mediaDevices?.enumerateDevices().catch(() => []) ?? [];
  const { settings } = state;
  const info = {
    userAgent: navigator.userAgent,
    screen: `${screen.width}×${screen.height} @${devicePixelRatio}x`,
    cameras: devices.filter((d) => d.kind === 'videoinput').map((d) => d.label || '(未授權)'),
    current: { width: settings.width, height: settings.height, frameRate: settings.frameRate, facingMode: settings.facingMode },
    zoom: state.caps.zoom ?? null,
    torch: !!state.caps.torch,
    focusMode: state.caps.focusMode ?? null,
    poseDetector: poseStatus,
  };
  $('device-info').textContent = JSON.stringify(info, null, 2);
}
$('btn-copy-info').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('device-info').textContent);
    $('btn-copy-info').textContent = '已複製 ✓';
  } catch {
    $('btn-copy-info').textContent = '請手動選取複製';
  }
};

/* ---------- 啟動 ---------- */
applySettings();
setMode(['auto', 'photo', 'burst'].includes(settings.mode) ? settings.mode : 'photo');
navigator.storage?.persist?.().catch(() => {}); // 請瀏覽器不要自動清掉照片

startCamera();
refreshThumb();
loadPoseDetector();
// 依手機速度調整偵測頻率：偵測花的時間越久，間隔拉越長，畫面才不會卡
(function hintLoop() {
  const t0 = performance.now();
  try { updateHint(); } catch (err) { console.warn(err); }
  const cost = performance.now() - t0;
  setTimeout(hintLoop, Math.min(1500, Math.max(250, cost * 3))); // 最多 1.5 秒更新一次
})();
// APK 內的檔案本來就在手機上，不需要 Service Worker 快取
if ('serviceWorker' in navigator && !isNative) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
