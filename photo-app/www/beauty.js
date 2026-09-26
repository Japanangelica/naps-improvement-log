'use strict';

/*
 * 進階美化：美肌、背景虛化、小臉、瘦腰，以及連拍挑最佳一張。
 * 需要的資訊（人物分割、臉部特徵點、骨架）在拍照時分析一次並存起來，
 * 之後調整滑桿只重新繪製，不必再跑 AI 模型。
 *
 * 純函式（remapRow、bump、bandScale、faceBand、waistBand、sharpness、scoreShot、pickBest）可在 Node 測試。
 */

// selfie_multiclass_256x256 的分類
const CAT = { BACKGROUND: 0, HAIR: 1, BODY_SKIN: 2, FACE_SKIN: 3, CLOTHES: 4, OTHER: 5 };

// MediaPipe Face Landmarker（478 點）中不要磨皮的五官
const FEATURES = {
  leftEye: [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246],
  rightEye: [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466],
  leftBrow: [70, 63, 105, 66, 107, 55, 65, 52, 53, 46],
  rightBrow: [336, 296, 334, 293, 300, 276, 283, 282, 295, 285],
  lips: [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185],
};
const NOSE_TIP = 1, CHIN = 152, CHEEK_L = 234, CHEEK_R = 454;

/** 預設美化程度（0–100；長腿為 0–15 的百分比） */
const DEFAULTS = { legs: 6, face: 25, waist: 15, skin: 30, blur: 20 };

/* ---------- 形狀調整（小臉、瘦腰）：逐列水平壓縮 ---------- */

/** 0→1→0 的平滑鼓起曲線 */
function bump(t) {
  return t <= 0 || t >= 1 ? 0 : Math.sin(Math.PI * t);
}

/**
 * 一列的水平重新對應：中心 [cx-w, cx+w] 縮成 [cx-w*s, cx+w*s]，
 * 兩側 [w, R] 拉寬補滿，R 以外不動。回傳 3 段 {sx, sw, dx, dw}。
 */
function remapRow(cx, w, R, s) {
  return [
    { sx: cx - R, sw: R - w, dx: cx - R, dw: R - w * s },
    { sx: cx - w, sw: 2 * w, dx: cx - w * s, dw: 2 * w * s },
    { sx: cx + w, sw: R - w, dx: cx + w * s, dw: R - w * s },
  ];
}

/** 形狀調整區域第 y 列的縮放倍率 */
function bandScale(band, y, k) {
  return 1 - k * bump((y - band.top) / (band.bottom - band.top));
}

/** 小臉：鼻尖到下巴下方，壓縮下半臉（下顎） */
function faceBand(face, W, H) {
  if (!face) return null;
  const pt = (i) => ({ x: face[i * 2] * W, y: face[i * 2 + 1] * H });
  const l = pt(CHEEK_L), r = pt(CHEEK_R), nose = pt(NOSE_TIP), chin = pt(CHIN);
  const half = Math.abs(r.x - l.x) / 2;
  if (half < 8 || chin.y <= nose.y) return null;
  return {
    cx: (l.x + r.x) / 2,
    top: nose.y - (chin.y - nose.y) * 0.3,
    bottom: chin.y + (chin.y - nose.y) * 0.35,
    w: half * 1.02,
    R: half * 1.75,
    maxK: 0.09,
  };
}

/** 瘦腰：肩膀到髖部之間，最細處在腰。側身時兩肩太靠近，不處理（會變形） */
function waistBand(a, W, H) {
  if (!a || a.shoulderY == null) return null;
  const sh = a.shoulderY * H, hip = a.hipY * H;
  if (hip - sh < 20) return null;
  const torso = hip - sh;
  if (a.shoulderHalf * W < torso * 0.22) return null; // 側身
  const half = Math.max(a.hipHalf * W * 1.5, a.shoulderHalf * W * 0.85);
  return {
    cx: ((a.hipX + a.shoulderX) / 2) * W,
    top: sh + (hip - sh) * 0.3,
    bottom: hip + (hip - sh) * 0.2,
    w: half,
    R: half * 2.2,
    maxK: 0.06,
  };
}

function warpBand(src, W, H, band, strength) {
  const k = band.maxK * strength;
  const out = copyCanvas(src, W, H);
  if (k <= 0) return out;
  const g = out.getContext('2d');
  const top = Math.max(0, Math.floor(band.top)), bottom = Math.min(H, Math.ceil(band.bottom));
  const R = Math.min(band.R, band.cx, W - band.cx);
  const w = Math.min(band.w, R * 0.9);
  for (let y = top; y < bottom; y++) {
    const s = bandScale(band, y + 0.5, k);
    for (const seg of remapRow(band.cx, w, R, s)) {
      if (seg.sw > 0 && seg.dw > 0) g.drawImage(src, seg.sx, y, seg.sw, 1, seg.dx, y, seg.dw, 1);
    }
  }
  return out;
}

/* ---------- 連拍挑最佳 ---------- */

/** 灰階影像的清晰度（拉普拉斯變異數，越大越清楚） */
function sharpness(gray, w, h) {
  let sum = 0, sum2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
      sum += v; sum2 += v * v; n++;
    }
  }
  if (!n) return 0;
  const mean = sum / n;
  return sum2 / n - mean * mean;
}

/**
 * 一張照片的分數（0–1）：眼睛張開最重要，其次是笑容、清晰度、構圖。
 * @param {{blink:number|null, smile:number|null, sharp:number, level:string}} s
 * @param {number} maxSharp 同一組連拍中最清楚的值
 */
function scoreShot(s, maxSharp) {
  const hasFace = s.blink != null;
  const eyes = hasFace ? 1 - Math.min(1, s.blink) : 0.5;
  const smile = hasFace ? Math.min(1, s.smile ?? 0) : 0.3;
  const sharp = maxSharp > 0 ? s.sharp / maxSharp : 1;
  const comp = { ok: 1, tip: 0.5, warn: 0 }[s.level] ?? 0.5;
  return 0.4 * eyes + 0.25 * smile + 0.2 * sharp + 0.15 * comp;
}

function pickBest(shots) {
  const maxSharp = Math.max(0, ...shots.map((s) => s.sharp));
  let best = 0, bestScore = -1;
  shots.forEach((s, i) => {
    const sc = scoreShot(s, maxSharp);
    if (sc > bestScore) { bestScore = sc; best = i; }
  });
  return best;
}

/** 說明為什麼推薦這張 */
function bestReason(s) {
  const parts = [];
  if (s.blink != null && s.blink < 0.35) parts.push('眼睛張開');
  if (s.smile != null && s.smile > 0.4) parts.push('笑容自然');
  parts.push('畫面清晰');
  return parts.join('、');
}

/* ---------- 瀏覽器端：分析與繪製 ---------- */

function copyCanvas(src, W, H) {
  const c = makeCanvas(W, H);
  c.getContext('2d').drawImage(src, 0, 0, W, H);
  return c;
}

function scaled(src, W, H, max) {
  const k = Math.min(1, max / Math.max(W, H));
  const c = makeCanvas(Math.max(1, Math.round(W * k)), Math.max(1, Math.round(H * k)));
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c;
}

/**
 * 分析一張照片（拍照後執行一次）。
 * @param {HTMLCanvasElement} canvas 原圖
 * @param {{segmenter?, face?}} models MediaPipe 的 ImageSegmenter / FaceLandmarker（IMAGE 模式）
 */
function analyze(canvas, models, { sharpness: withSharpness = true } = {}) {
  const small = scaled(canvas, canvas.width, canvas.height, 768);
  const out = { face: null, blink: null, smile: null, mask: null, sharp: 0 };

  if (models.face) {
    try {
      const r = models.face.detect(small);
      const lm = r.faceLandmarks?.[0];
      if (lm) {
        out.face = new Float32Array(lm.length * 2);
        lm.forEach((p, i) => { out.face[i * 2] = p.x; out.face[i * 2 + 1] = p.y; });
        const cats = Object.fromEntries((r.faceBlendshapes?.[0]?.categories ?? []).map((c) => [c.categoryName, c.score]));
        out.blink = Math.max(cats.eyeBlinkLeft ?? 0, cats.eyeBlinkRight ?? 0);
        out.smile = ((cats.mouthSmileLeft ?? 0) + (cats.mouthSmileRight ?? 0)) / 2;
      }
    } catch (err) { console.warn('臉部分析失敗', err); }
  }

  if (models.segmenter) {
    try {
      const r = models.segmenter.segment(small);
      const m = r.categoryMask;
      if (m) out.mask = shrinkMask(m.getAsUint8Array(), m.width, m.height, 384);
      r.close?.();
    } catch (err) { console.warn('人物分割失敗', err); }
  }

  if (!withSharpness) return out;
  // 清晰度：縮到 200px 寬的灰階
  const g = scaled(canvas, canvas.width, canvas.height, 200);
  const { data } = g.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, g.width, g.height);
  const gray = new Float32Array(g.width * g.height);
  for (let i = 0; i < gray.length; i++) gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  out.sharp = sharpness(gray, g.width, g.height);
  return out;
}

/** 分類遮罩縮小到最長邊 max（最近鄰），存起來比較省空間 */
function shrinkMask(data, w, h, max) {
  const k = Math.min(1, max / Math.max(w, h));
  const nw = Math.max(1, Math.round(w * k)), nh = Math.max(1, Math.round(h * k));
  const out = new Uint8Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(h - 1, Math.floor((y + 0.5) / k));
    for (let x = 0; x < nw; x++) out[y * nw + x] = data[sy * w + Math.min(w - 1, Math.floor((x + 0.5) / k))];
  }
  return { w: nw, h: nh, data: out };
}

/** 依分類做出遮罩（放大到照片尺寸，邊緣柔化） */
function maskCanvas(mask, cats, W, H, feather) {
  const m = makeCanvas(mask.w, mask.h);
  const ctx = m.getContext('2d');
  const img = ctx.createImageData(mask.w, mask.h);
  for (let i = 0; i < mask.data.length; i++) {
    if (cats.includes(mask.data[i])) img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const out = makeCanvas(W, H);
  const o = out.getContext('2d');
  o.filter = `blur(${Math.max(1, feather)}px)`;
  o.drawImage(m, 0, 0, W, H);
  return out;
}

/**
 * 模糊版影像：先縮小再模糊再放大，速度快。
 * 四周先延伸一圈再模糊，照片邊緣才不會出現條紋。
 */
function blurred(src, W, H, factor, radius) {
  const sw = Math.max(1, Math.round(W / factor)), sh = Math.max(1, Math.round(H / factor));
  const pad = Math.ceil(radius * 3) + 2;
  const s = makeCanvas(sw + pad * 2, sh + pad * 2);
  const g = s.getContext('2d');
  g.drawImage(src, 0, 0, s.width, s.height); // 延伸邊緣
  g.drawImage(src, pad, pad, sw, sh);
  const b = makeCanvas(s.width, s.height);
  const bg = b.getContext('2d');
  bg.filter = `blur(${radius}px)`;
  bg.drawImage(s, 0, 0);
  const out = makeCanvas(W, H);
  const o = out.getContext('2d');
  o.imageSmoothingQuality = 'high';
  o.drawImage(b, pad, pad, sw, sh, 0, 0, W, H);
  return out;
}

function withMask(layer, maskC) {
  const g = layer.getContext('2d');
  g.globalCompositeOperation = 'destination-in';
  g.drawImage(maskC, 0, 0);
  g.globalCompositeOperation = 'source-over';
  return layer;
}

/** 美肌：只處理臉部與身體皮膚，避開眼睛、眉毛、嘴唇 */
function smoothSkin(base, W, H, info, strength) {
  const skin = maskCanvas(info.mask, [CAT.FACE_SKIN, CAT.BODY_SKIN], W, H, W / 300);
  if (info.face) {
    const g = skin.getContext('2d');
    g.globalCompositeOperation = 'destination-out';
    g.filter = `blur(${Math.max(1, W / 400)}px)`;
    g.fillStyle = '#000';
    for (const idx of Object.values(FEATURES)) {
      g.beginPath();
      idx.forEach((i, n) => {
        const x = info.face[i * 2] * W, y = info.face[i * 2 + 1] * H;
        if (n) g.lineTo(x, y); else g.moveTo(x, y);
      });
      g.closePath();
      g.fill();
    }
  }
  // 模糊半徑小一點、疊加比例保守，保留皮膚質感，避免「塑膠臉」
  const soft = withMask(blurred(base, W, H, 2, Math.max(1.5, W / 2 / 260)), skin);
  const out = copyCanvas(base, W, H);
  const g = out.getContext('2d');
  g.globalAlpha = 0.15 + 0.5 * strength;
  g.filter = `brightness(${(1 + 0.03 * strength).toFixed(3)})`;
  g.drawImage(soft, 0, 0);
  return out;
}

/**
 * 背景虛化：人物清楚、背景模糊。
 * 先把人物挖掉只模糊背景，人物的顏色就不會暈到背景上（避免人物外圍一圈光暈）。
 */
function blurBackground(base, W, H, info, strength) {
  const hard = maskCanvas(info.mask, [CAT.BACKGROUND], W, H, 1);
  const bgOnly = withMask(copyCanvas(base, W, H), hard);
  const radius = Math.max(1, (W / 3) * (0.003 + 0.012 * strength));
  const soft = blurred(bgOnly, W, H, 3, radius);
  // 挖掉人物的地方模糊後會變半透明，重疊幾次補回不透明度（顏色只來自背景）
  const filled = makeCanvas(W, H);
  const f = filled.getContext('2d');
  for (let i = 0; i < 4; i++) f.drawImage(soft, 0, 0);
  const feather = maskCanvas(info.mask, [CAT.BACKGROUND], W, H, W / 400);
  const out = copyCanvas(base, W, H);
  out.getContext('2d').drawImage(withMask(filled, feather), 0, 0);
  return out;
}

/**
 * 產生美化後的照片。
 * @param src 原圖（canvas / ImageBitmap）
 * @param info 分析結果：{anchors, face, mask, ...}
 * @param p 美化程度：{legs(0–15), face, waist, skin, blur(0–100)}
 */
function render(src, W, H, info = {}, p = DEFAULTS, { enhance = true } = {}) {
  let img = src;
  const pct = (v) => Math.max(0, Math.min(100, v || 0)) / 100;
  if (info.mask && pct(p.blur) > 0) img = blurBackground(img, W, H, info, pct(p.blur));
  if (info.mask && pct(p.skin) > 0) img = smoothSkin(img, W, H, info, pct(p.skin));
  const fb = faceBand(info.face, W, H);
  if (fb && pct(p.face) > 0) img = warpBand(img, W, H, fb, pct(p.face));
  const wb = waistBand(info.anchors, W, H);
  if (wb && pct(p.waist) > 0) img = warpBand(img, W, H, wb, pct(p.waist));
  return Retouch.render(img, W, H, { anchors: info.anchors, legs: (p.legs || 0) / 100, enhance });
}

/** 這張照片可以用哪些美化（沒偵測到臉就不能小臉，以此類推） */
function available(info = {}) {
  return {
    legs: !!info.anchors,
    waist: !!(info.anchors && info.anchors.shoulderY != null),
    face: !!info.face,
    skin: !!info.mask,
    blur: !!info.mask,
  };
}

const Beauty = {
  CAT, DEFAULTS, bump, remapRow, shrinkMask, bandScale, faceBand, waistBand,
  sharpness, scoreShot, pickBest, bestReason, analyze, render, available,
};
if (typeof module !== 'undefined') module.exports = Beauty;
else self.Beauty = Beauty;
