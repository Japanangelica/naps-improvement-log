'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { poseAnchors, rowScale, legPlan, enhanceFilter } = require('../www/retouch.js');

function lm({ hipY = 0.55, eyeY = 0.12, mouthY = 0.16, ankleVis = 1 } = {}) {
  const p = (y, visibility = 1) => ({ x: 0.5, y, visibility });
  const a = Array.from({ length: 33 }, () => p(0.5));
  a[2] = a[5] = p(eyeY);
  a[9] = a[10] = p(mouthY);
  a[23] = a[24] = p(hipY);
  a[27] = a[28] = p(0.95, ankleVis);
  return a;
}

test('看得到髖部和腳踝才做長腿', () => {
  const a = poseAnchors(lm());
  assert.ok(Math.abs(a.hipY - 0.55) < 1e-9);
  assert.ok(Math.abs(a.ankleY - 0.95) < 1e-9);
  assert.ok(Math.abs(a.headTop - (0.12 - 0.04 * 1.6)) < 1e-9);
  assert.strictEqual(poseAnchors(lm({ ankleVis: 0.1 })), null);
  assert.strictEqual(poseAnchors(null), null);
});

test('拉伸倍率在腰部和腳踝都是 1 倍，整段平均為 1 + amount', () => {
  assert.strictEqual(rowScale(0, 0.08), 1);
  assert.strictEqual(rowScale(1, 0.08), 1);
  const n = 10000;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += rowScale((i + 0.5) / n, 0.08);
  assert.ok(Math.abs(sum / n - 1.08) < 1e-3);
});

test('只拉長腰到腳踝，腳掌不拉', () => {
  const plan = legPlan({ hipY: 0.5, headTop: 0.2, ankleY: 0.89 }, 4000, 0.1);
  assert.strictEqual(plan.span, 1600); // (0.89 + 0.01) × 4000 − 2000
  assert.ok(Math.abs(plan.added - 160) <= 1);
});

test('頭頂留白夠時裁掉上方，照片高度不變', () => {
  const plan = legPlan({ hipY: 0.5, headTop: 0.2 }, 4000, 0.08);
  assert.strictEqual(plan.hip, 2000);
  assert.ok(Math.abs(plan.added - 160) <= 1); // 下半身 2000px × 8%
  assert.strictEqual(plan.cropTop, plan.added);
  assert.strictEqual(plan.outH, 4000);
});

test('頭頂留白不夠時照片變高', () => {
  const plan = legPlan({ hipY: 0.5, headTop: 0.06 }, 4000, 0.08);
  assert.strictEqual(plan.cropTop, 80); // (0.06 - 0.04) × 4000
  assert.strictEqual(plan.outH, 4000 + plan.added - 80);
});

test('腰部位置不合理或沒有加長時不處理', () => {
  assert.strictEqual(legPlan({ hipY: 0.1, headTop: 0.05 }, 4000, 0.08), null);
  assert.strictEqual(legPlan({ hipY: 0.95, headTop: 0.05 }, 4000, 0.08), null);
  assert.strictEqual(legPlan({ hipY: 0.5, headTop: 0.2 }, 4000, 0), null);
});

test('偏暗的照片會提亮，太亮的不會過度壓暗', () => {
  const b = (f) => Number(f.match(/brightness\(([\d.]+)\)/)[1]);
  assert.ok(b(enhanceFilter(60)) > 1.15);
  assert.ok(b(enhanceFilter(120)) === 1);
  assert.ok(b(enhanceFilter(230)) >= 0.97);
});

test('長腿後座標換算：腰部以上只受頭頂裁切影響，腳底往下移', () => {
  const { mapY } = require('../www/retouch.js');
  const plan = legPlan({ hipY: 0.5, headTop: 0.2, ankleY: 0.89 }, 4000, 0.1);
  assert.strictEqual(mapY(plan, 1000), 1000 - plan.cropTop);
  assert.ok(Math.abs(mapY(plan, 3800) - (3800 + plan.added - plan.cropTop)) < 1);
  assert.strictEqual(mapY(null, 1234), 1234);
});
