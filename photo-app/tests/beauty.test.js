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
  assert.deepStrictEqual(B.available({}), { legs: false, waist: false, face: false, skin: false, blur: false });
  const av = B.available({ anchors: { shoulderY: 0.3 }, face: new Float32Array(2), mask: {} });
  assert.ok(Object.values(av).every(Boolean));
});

test('分類遮罩縮小保留類別', () => {
  const w = 8, h = 4, data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 4; x < 8; x++) data[y * w + x] = 3; // 右半是臉
  const m = B.shrinkMask(data, w, h, 4);
  assert.deepStrictEqual([m.w, m.h], [4, 2]);
  assert.deepStrictEqual([...m.data], [0, 0, 3, 3, 0, 0, 3, 3]);
});
