'use strict';

/*
 * 自動美化：長腿（只拉長腰部以下）＋自動亮度與氣色。
 * legPlan()/rowScale() 為純函式，方便測試；render() 需要瀏覽器的 canvas。
 */

const RAMP_UP = 0.25;     // 腰部往下 25% 內，拉伸量由 0 漸增，避免腰部出現斷層
const RAMP_DOWN = 0.15;   // 接近腳踝的 15% 內漸減回 0，鞋子和腳掌不會被拉長
const MIN_HEADROOM = 0.04; // 裁掉頭頂留白時，至少保留畫面高度 4%

/** 建立畫布：主畫面用 <canvas>，背景執行緒（Worker）用 OffscreenCanvas */
function makeCanvas(w, h) {
  if (typeof document === 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function smoothstep(t) {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/**
 * 從骨架取出美化需要的位置（0–1，相對照片寬高）。
 * 需要看得到兩側髖部與至少一側腳踝，否則回傳 null（不做長腿、瘦腰）。
 */
function poseAnchors(lm, visible = 0.5) {
  if (!lm) return null;
  const ok = (i) => lm[i] && lm[i].visibility >= visible && lm[i].y >= 0 && lm[i].y <= 1.02;
  if (!ok(23) || !ok(24) || !(ok(27) || ok(28))) return null;
  const hipY = (lm[23].y + lm[24].y) / 2;
  const eyeY = (lm[2].y + lm[5].y) / 2;
  const mouthY = (lm[9].y + lm[10].y) / 2;
  const headTop = eyeY - Math.max(mouthY - eyeY, 0.01) * 1.6;
  const ankleY = Math.max(...[27, 28].filter(ok).map((i) => lm[i].y));
  const both = ok(11) && ok(12);
  return {
    hipY,
    headTop,
    ankleY,
    hipX: (lm[23].x + lm[24].x) / 2,
    hipHalf: Math.abs(lm[23].x - lm[24].x) / 2,
    shoulderY: both ? (lm[11].y + lm[12].y) / 2 : null,
    shoulderX: both ? (lm[11].x + lm[12].x) / 2 : null,
    shoulderHalf: both ? Math.abs(lm[11].x - lm[12].x) / 2 : null,
  };
}

function profile(u) {
  return smoothstep(u / RAMP_UP) * smoothstep((1 - u) / RAMP_DOWN);
}

// 曲線下面積，用來換算最大拉伸倍率
const PROFILE_AREA = (() => {
  const n = 2000;
  let a = 0;
  for (let i = 0; i < n; i++) a += profile((i + 0.5) / n);
  return a / n;
})();

/** 拉伸範圍（腰→腳踝）內第 u（0–1）處的拉伸倍率；整段平均倍率 = 1 + amount */
function rowScale(u, amount) {
  return 1 + (amount / PROFILE_AREA) * profile(u);
}

/**
 * 計算長腿方式。H 為照片高度（像素），amount 為腿部加長比例（0.08 = 8%）。
 * 若頭頂留白夠，就從上方裁掉同樣高度，讓照片尺寸不變；不夠就讓照片變高一點。
 */
function legPlan(anchors, H, amount) {
  if (!anchors || !(amount > 0)) return null;
  const { hipY, headTop } = anchors;
  if (hipY < 0.25 || hipY > 0.85) return null;
  const hip = Math.round(hipY * H);
  const lower = H - hip;
  // 只拉長腰部到腳踝（略低於腳踝），腳掌和地面維持原樣
  const ankle = anchors.ankleY != null ? Math.round((anchors.ankleY + 0.01) * H) : H;
  const span = Math.max(Math.round(lower * 0.3), Math.min(lower, ankle - hip));
  let added = 0;
  for (let i = 0; i < span; i++) added += rowScale((i + 0.5) / span, amount) - 1;
  added = Math.round(added);
  const spare = Math.round((headTop - MIN_HEADROOM) * H);
  const cropTop = spare >= added ? added : Math.max(0, spare);
  return { hip, lower, span, added, cropTop, outH: H + added - cropTop };
}

/** 依畫面平均亮度決定美化濾鏡：偏暗就提亮，並稍微加強對比與飽和度 */
function enhanceFilter(meanLuma) {
  const b = Math.min(1.25, Math.max(0.97, 1 + (120 - meanLuma) / 255 * 0.9));
  return `brightness(${b.toFixed(3)}) contrast(1.05) saturate(1.12)`;
}

function meanLuma(src, W, H) {
  const c = makeCanvas(32, Math.max(1, Math.round(32 * H / W)));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, c.width, c.height);
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  return sum / (data.length / 4);
}

/**
 * 產生美化後的照片。src：canvas / ImageBitmap（原圖）。
 * @returns {HTMLCanvasElement}
 */
function render(src, W, H, { anchors, legs = 0, enhance = true } = {}) {
  const plan = legPlan(anchors, H, legs);
  let shaped = src;
  let outH = H;
  if (plan) {
    // 第 1 步：只做形狀（長腿），不套濾鏡；逐列繪製很快
    const { hip, lower, span, cropTop } = plan;
    outH = plan.outH;
    shaped = makeCanvas(W, outH);
    const g = shaped.getContext('2d');
    g.drawImage(src, 0, cropTop, W, hip - cropTop, 0, 0, W, hip - cropTop);
    let y = hip - cropTop;
    for (let i = 0; i < lower; i++) {
      const s = i < span ? rowScale((i + 0.5) / span, legs) : 1;
      g.drawImage(src, 0, hip + i, W, 1, 0, y, W, s + 0.75);
      y += s;
    }
  }
  // 第 2 步：整張一次套上美化濾鏡（濾鏡只算一次）
  const out = makeCanvas(W, outH);
  const ctx = out.getContext('2d');
  ctx.filter = enhance ? enhanceFilter(meanLuma(src, W, H)) : 'none';
  ctx.drawImage(shaped, 0, 0);
  return out;
}

const Retouch = { poseAnchors, rowScale, legPlan, enhanceFilter, render };
if (typeof module !== 'undefined') module.exports = Retouch;
else Object.assign(self, { Retouch, makeCanvas });
