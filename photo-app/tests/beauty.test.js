'use strict';
const test = require('node:test');
const assert = require('node:assert');
const B = require('../www/beauty.js');

test('水平重新對應：中心縮小、兩側補滿，總寬度不變', () => {
  const segs = B.remapRow(500, 100, 200, 0.9);
  assert.strictEqual(segs[0].dx, 300);                          // 左邊界不動
  assert.strictEqual(segs[1].dx, 500 - 90);                     // 中心縮成 ±90
  assert.strictEqual(segs[1].dw, 180);
  const right = segs[2].dx + segs[2].dw;
  assert.strictEqual(right, 700);                               // 右邊界不動
  assert.strictEqual(segs[0].dx + segs[0].dw, segs[1].dx);      // 各段相接，沒有縫
  assert.strictEqual(segs[1].dx + segs[1].dw, segs[2].dx);
});

test('形狀調整在區域上下緣為 1 倍，中間最窄', () => {
  const band = { top: 100, bottom: 300 };
  assert.strictEqual(B.bandScale(band, 100, 0.1), 1);
  assert.strictEqual(B.bandScale(band, 300, 0.1), 1);
  assert.ok(Math.abs(B.bandScale(band, 200, 0.1) - 0.9) < 1e-9);
});

test('小臉區域取自臉頰寬度與鼻尖到下巴', () => {
  const face = new Float32Array(478 * 2);
  const set = (i, x, y) => { face[i * 2] = x; face[i * 2 + 1] = y; };
  set(234, 0.4, 0.3); set(454, 0.6, 0.3); set(1, 0.5, 0.32); set(152, 0.5, 0.42);
  const b = B.faceBand(face, 1000, 1000);
  assert.ok(Math.abs(b.cx - 500) < 1e-3);
  assert.ok(Math.abs(b.w - 102) < 1e-3);
  assert.ok(b.top < 320 && b.bottom > 420);
  assert.strictEqual(B.faceBand(null, 1000, 1000), null);
});

test('瘦腰需要肩膀與髖部', () => {
  const a = { hipY: 0.6, hipX: 0.5, hipHalf: 0.05, shoulderY: 0.3, shoulderX: 0.5, shoulderHalf: 0.1 };
  const b = B.waistBand(a, 1000, 1000);
  assert.strictEqual(b.cx, 500);
  assert.ok(b.top > 300 && b.bottom > 600);
  assert.strictEqual(B.waistBand({ ...a, shoulderY: null }, 1000, 1000), null);
});

test('清晰度：有細節的影像比平坦的高', () => {
  const w = 20, h = 20;
  const flat = new Float32Array(w * h).fill(128);
  const sharp = new Float32Array(w * h).map((_, i) => ((i % w) + Math.floor(i / w)) % 2 ? 255 : 0);
  assert.strictEqual(B.sharpness(flat, w, h), 0);
  assert.ok(B.sharpness(sharp, w, h) > 1000);
});

test('連拍挑最佳：閉眼的不選，笑的優先', () => {
  const shots = [
    { blink: 0.9, smile: 0.9, sharp: 100, level: 'ok' },  // 閉眼
    { blink: 0.1, smile: 0.2, sharp: 100, level: 'ok' },
    { blink: 0.1, smile: 0.8, sharp: 95, level: 'ok' },   // 張眼＋笑
    { blink: 0.1, smile: 0.8, sharp: 30, level: 'ok' },   // 糊掉
  ];
  assert.strictEqual(B.pickBest(shots), 2);
  assert.strictEqual(B.bestReason(shots[2]), '眼睛張開、笑容自然、畫面清晰');
});

test('沒有臉時依清晰度與構圖選', () => {
  const shots = [
    { blink: null, smile: null, sharp: 50, level: 'warn' },
    { blink: null, smile: null, sharp: 100, level: 'ok' },
  ];
  assert.strictEqual(B.pickBest(shots), 1);
});

test('依分析結果判斷可用的美化', () => {
  assert.deepStrictEqual(B.available({}), { frame: false, legs: false, waist: false, face: false, skin: false, blur: false });
  const av = B.available({ anchors: { shoulderY: 0.3 }, framing: {}, face: new Float32Array(2), mask: {} });
  assert.ok(Object.values(av).every(Boolean));
});

test('分類遮罩縮小保留類別', () => {
  const w = 8, h = 4, data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 4; x < 8; x++) data[y * w + x] = 3; // 右半是臉
  const m = B.shrinkMask(data, w, h, 4);
  assert.deepStrictEqual([m.w, m.h], [4, 2]);
  assert.deepStrictEqual([...m.data], [0, 0, 3, 3, 0, 0, 3, 3]);
});

test('構圖修正：全身照地板太多 → 裁掉地板，腳底貼近下緣', () => {
  // 頭頂在 20%、腳底在 70%，下面 30% 都是地板
  const r = B.compositionCrop({ headTop: 0.2, feetY: 0.7, centerX: 0.5 }, 3000, 4000, 1);
  assert.ok(r);
  const feetInCrop = (0.7 * 4000 - r.y) / r.h;
  const headInCrop = (0.2 * 4000 - r.y) / r.h;
  assert.ok(feetInCrop > 0.93 && feetInCrop < 1, `腳底在裁切後的 ${feetInCrop}`);
  assert.ok(headInCrop > 0.05 && headInCrop < 0.2, `頭頂在裁切後的 ${headInCrop}`);
  assert.ok(Math.abs(r.w / r.h - 3000 / 4000) < 1e-9); // 長寬比不變
  assert.ok(r.h >= 4000 * 0.55);
});

test('構圖修正：人很小時（受限最小裁切）多的空間上下分配，地板與天空都減少', () => {
  const r = B.compositionCrop({ headTop: 0.3, feetY: 0.65, centerX: 0.5 }, 3000, 4000, 1);
  const feetInCrop = (0.65 * 4000 - r.y) / r.h;
  const headInCrop = (0.3 * 4000 - r.y) / r.h;
  assert.ok(Math.abs(r.h - 4000 * 0.55) < 1e-6);
  assert.ok(feetInCrop > 0.85 && feetInCrop < 1);   // 原本 0.65
  assert.ok(headInCrop > 0.15 && headInCrop < 0.3); // 原本 0.3
});

test('構圖修正：半身照天空太多 → 只裁上方', () => {
  const r = B.compositionCrop({ headTop: 0.45, feetY: null, centerX: 0.5 }, 3000, 4000, 1);
  assert.ok(r);
  assert.ok(Math.abs(r.y + r.h - 4000) < 1e-6); // 下緣不動
  const headInCrop = (0.45 * 4000 - r.y) / r.h;
  assert.ok(headInCrop < 0.2);
});

test('構圖修正：人物偏一邊時裁切框跟著人，但不超出照片', () => {
  const r = B.compositionCrop({ headTop: 0.3, feetY: 0.65, centerX: 0.95 }, 3000, 4000, 1);
  assert.ok(r.x + r.w <= 3000 + 1e-6);
  assert.ok(r.x > 0);
});

test('構圖修正：本來就好、或強度 0 時不裁', () => {
  assert.strictEqual(B.compositionCrop({ headTop: 0.08, feetY: 0.96, centerX: 0.5 }, 3000, 4000, 1), null);
  assert.strictEqual(B.compositionCrop({ headTop: 0.3, feetY: 0.65, centerX: 0.5 }, 3000, 4000, 0), null);
  assert.strictEqual(B.compositionCrop(null, 3000, 4000, 1), null);
});

test('構圖修正強度 50% 介於原圖與理想之間', () => {
  const full = B.compositionCrop({ headTop: 0.3, feetY: 0.65, centerX: 0.5 }, 3000, 4000, 1);
  const half = B.compositionCrop({ headTop: 0.3, feetY: 0.65, centerX: 0.5 }, 3000, 4000, 0.5);
  assert.ok(half.h > full.h && half.h < 4000);
});

test('構圖修正不會切到張開的手臂', () => {
  const f = { headTop: 0.36, feetY: 0.94, centerX: 0.48, minX: 0.02, maxX: 0.98 };
  const r = B.compositionCrop(f, 3000, 4000, 1);
  if (r) {
    assert.ok(r.x <= 0.02 * 3000 + 1 && r.x + r.w >= 0.98 * 3000 - 1, '手臂要在框內');
  }
  const narrow = B.compositionCrop({ ...f, minX: 0.35, maxX: 0.65 }, 3000, 4000, 1);
  assert.ok(narrow && narrow.h < 4000 * 0.9); // 手沒張開時照常裁
});
