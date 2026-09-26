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
  busy: false,
  track: null,
  caps: {},          // 目前鏡頭支援的功能（變焦、補光燈、對焦…）
  backCams: [],      // 三星等多鏡頭手機的後鏡頭清單（超廣角、主鏡頭、望遠）
  backIndex: 0,
  zoom: 1,
  torch: false,
  wakeLock: null,
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

    const shots = state.burst ? 5 : 1;
    const pending = [];
    for (let i = 0; i < shots; i++) {
      if (i) await new Promise((r) => setTimeout(r, 200));
      pending.push(capture().then((blob) => db.add({ blob, createdAt: Date.now() })));
      flash();
    }
    await Promise.all(pending);
    await refreshThumb();
  } finally {
    state.busy = false;
  }
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

function capture() {
  const { sx, sy, sw, sh } = currentCrop();
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
  return new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
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
    const { FilesetResolver, PoseLandmarker } = await import(`${MP_BASE}/vision_bundle.mjs`);
    const fileset = await FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
    const create = (delegate) => PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: POSE_MODEL, delegate },
      runningMode: 'VIDEO',
      numPoses: 1,
    });
    poseDetector = await create('GPU').catch(() => create('CPU'));
    poseStatus = 'ready';
  } catch (err) {
    console.warn('人物偵測載入失敗，只使用亮度與角度提示', err);
    poseStatus = 'failed';
  }
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
  return {
    tilt: flat ? 0 : Hints.tiltFromGravity(g),
    pitchDown: Hints.pitchDownFromBeta(sensor.beta, portrait),
  };
}

function updateHint() {
  const el = $('hint');
  const active = state.hints && state.stream && video.videoWidth && !$('camera-view').classList.contains('hidden');
  el.classList.toggle('hidden', !active);
  if (!active) return;

  const crop = currentCrop();
  lightCtx.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, lightCanvas.width, lightCanvas.height);
  const light = Hints.measureLight(lightCtx, lightCanvas.width, lightCanvas.height);

  let pose = null;
  if (poseDetector) {
    const ts = Math.max(performance.now(), lastPoseTs + 1);
    lastPoseTs = ts;
    const lm = poseDetector.detectForVideo(video, ts).landmarks?.[0];
    pose = lm ? Hints.mapPose(lm, video.videoWidth, video.videoHeight, crop) : null;
  }

  let hint = Hints.analyze({ light, motion: readMotion(), pose });
  if (hint.text.startsWith('太暗') && state.caps.torch && !state.torch) {
    hint = { ...hint, text: `${hint.text}，或打開上方 🔦 補光燈` };
  }
  if (!pose && hint.level === 'tip' && poseStatus === 'loading') {
    hint = { level: 'tip', text: '人物偵測載入中…' };
  }
  el.className = `hint ${hint.level}`;
  el.textContent = `${hint.level === 'ok' ? '✅' : hint.level === 'warn' ? '⚠️' : '💡'} ${hint.text}`;
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
$('btn-grid').onclick = (e) => {
  $('grid').classList.toggle('hidden');
  e.currentTarget.classList.toggle('on');
};
$('btn-timer').onclick = (e) => {
  const next = { 0: 3, 3: 10, 10: 0 }[state.timer];
  state.timer = next;
  $('timer-label').textContent = next ? ` ${next}s` : '';
  e.currentTarget.classList.toggle('on', next > 0);
};
$('filters').onclick = (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  document.querySelectorAll('#filters button').forEach((b) => b.classList.toggle('active', b === btn));
  state.filter = btn.dataset.filter;
  video.style.filter = state.filter === 'none' ? '' : state.filter;
};
$('btn-hints').onclick = (e) => {
  state.hints = !state.hints;
  e.currentTarget.classList.toggle('on', state.hints);
  updateHint();
};
$('btn-burst').onclick = (e) => {
  state.burst = !state.burst;
  $('burst-label').textContent = state.burst ? '×5' : '';
  e.currentTarget.classList.toggle('on', state.burst);
};
$('btn-gallery').onclick = () => showView('gallery');
$('btn-tips').onclick = () => showView('tips');
document.querySelectorAll('.btn-back-camera').forEach((b) => { b.onclick = () => showView('camera'); });
document.addEventListener('click', requestSensorPermission, { once: true });

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
startCamera();
refreshThumb();
loadPoseDetector();
setInterval(() => {
  try { updateHint(); } catch (err) { console.warn(err); }
}, 300);
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
