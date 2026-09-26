'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { analyze, tiltFromGravity, pitchDownFromBeta, measureLight, cropRect, mapPose } = require('../hints.js');

/** 產生一個站立人物的 33 點骨架：headTop 為頭頂 y，feetY 為腳底 y */
function person({ headTop = 0.1, feetY = 0.95, feetVisible = true } = {}) {
  const h = feetY - headTop;
  const at = (y, visibility = 1) => ({ x: 0.5, y: headTop + h * y, visibility });
  const lm = Array.from({ length: 33 }, () => at(0.5));
  // 眼到嘴距離 0.04h，頭頂 = 眼 - 1.6 × 0.04h
  const eye = 0.064, mouth = 0.104;
  lm[0] = at(0.08); lm[2] = at(eye); lm[5] = at(eye); lm[9] = at(mouth); lm[10] = at(mouth);
  lm[11] = lm[12] = at(0.18); lm[23] = lm[24] = at(0.5); lm[25] = lm[26] = at(0.72);
  const fv = feetVisible ? 1 : 0.1;
  lm[27] = lm[28] = at(0.97, fv); lm[29] = lm[30] = at(0.99, fv); lm[31] = lm[32] = at(1, fv);
  return lm;
}
const goodLight = { mean: 130, center: 130, edges: 130 };

test('構圖良好時顯示可以拍', () => {
  assert.strictEqual(analyze({ light: goodLight, pose: person() }).level, 'ok');
});

test('沒偵測到人時提示把人放進畫面', () => {
  assert.match(analyze({ light: goodLight, pose: null }).text, /放進畫面/);
});

test('太暗優先於其他提示', () => {
  const r = analyze({ light: { mean: 30, center: 30, edges: 30 }, pose: person({ feetY: 0.6 }) });
  assert.match(r.text, /太暗/);
});

test('背光', () => {
  assert.match(analyze({ light: { mean: 150, center: 80, edges: 200 } }).text, /背光/);
});

test('頭被切到', () => {
  assert.match(analyze({ light: goodLight, pose: person({ headTop: -0.05 }) }).text, /頭被切到/);
});

test('腳被切到', () => {
  assert.match(analyze({ light: goodLight, pose: person({ feetVisible: false }) }).text, /腳被切到/);
});

test('腳底離下緣太遠', () => {
  assert.match(analyze({ light: goodLight, pose: person({ headTop: 0.1, feetY: 0.7 }) }).text, /貼近下緣/);
});

test('頭頂留白太多', () => {
  assert.match(analyze({ light: goodLight, pose: person({ headTop: 0.5, feetY: 0.97 }) }).text, /頭頂上方空太多/);
});

test('人太小', () => {
  assert.match(analyze({ light: goodLight, pose: person({ headTop: 0.7, feetY: 0.95 }) }).text, /頭頂上方空太多|人太小/);
  assert.match(analyze({ light: goodLight, pose: person({ headTop: 0.35, feetY: 0.6 }).map((p, i) => i >= 25 ? { ...p, visibility: 0 } : p) }).text, /人太小/);
});

test('手機歪斜與俯拍', () => {
  assert.match(analyze({ motion: { tilt: 8, pitchDown: 0 } }).text, /歪了/);
  assert.match(analyze({ motion: { tilt: 0, pitchDown: 30 } }).text, /蹲低/);
  assert.strictEqual(analyze({ light: goodLight, motion: { tilt: 2, pitchDown: 5 }, pose: person() }).level, 'ok');
});

test('重力換算歪斜角度（直拿、橫拿皆可）', () => {
  assert.ok(tiltFromGravity({ x: 0, y: 9.8, z: 0 }) < 0.01);
  assert.ok(tiltFromGravity({ x: 9.8, y: 0, z: 0 }) < 0.01);
  const t = tiltFromGravity({ x: 9.8 * Math.sin(Math.PI / 18), y: -9.8 * Math.cos(Math.PI / 18), z: 0 });
  assert.ok(Math.abs(t - 10) < 0.01);
});

test('beta 換算俯拍角度，橫拿時不判斷', () => {
  assert.strictEqual(pitchDownFromBeta(60, true), 30);
  assert.strictEqual(pitchDownFromBeta(60, false), null);
});

test('亮度量測分中央與四周', () => {
  const w = 10, h = 10, data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = x > 3 && x < 7 && y > 2 && y < 6 ? 0 : 255;
    data.set([v, v, v, 255], (y * w + x) * 4);
  }
  const r = measureLight({ getImageData: () => ({ data }) }, w, h);
  assert.ok(r.center < 1 && r.edges > 254);
});

test('畫面比例裁切：3:4 影像裁成 9:16 與 1:1', () => {
  assert.deepStrictEqual(cropRect(3000, 4000, null), { sx: 0, sy: 0, sw: 3000, sh: 4000 });
  assert.deepStrictEqual(cropRect(3000, 4000, 9 / 16), { sx: 375, sy: 0, sw: 2250, sh: 4000 });
  assert.deepStrictEqual(cropRect(3000, 4000, 1), { sx: 0, sy: 500, sw: 3000, sh: 3000 });
});

test('裁成 1:1 後，原本在畫面內的腳可能被切掉', () => {
  const crop = cropRect(3000, 4000, 1);
  const [p] = mapPose([{ x: 0.5, y: 0.9, visibility: 1 }], 3000, 4000, crop);
  assert.ok(Math.abs(p.x - 0.5) < 1e-9);
  assert.ok(p.y > 1); // 0.9 × 4000 = 3600，超出裁切下緣 3500
});
