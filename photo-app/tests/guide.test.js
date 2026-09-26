'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { cueFor, Stability } = require('../www/guide.js');

function body(dx = 0, dy = 0) {
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 1 }));
  for (const i of [11, 12, 23, 24]) lm[i] = { x: 0.5 + dx, y: 0.4 + dy, visibility: 1 };
  return lm;
}

test('提示代碼對應方向', () => {
  assert.strictEqual(cueFor('pitch').dir, 'down');
  assert.strictEqual(cueFor('cut-feet').dir, 'up');
  assert.strictEqual(cueFor('small').dir, 'in');
  assert.strictEqual(cueFor('tilt').dir, 'level');
  assert.strictEqual(cueFor('ok'), null);
});

test('構圖 OK 且人物穩定 1.2 秒才觸發自動快門', () => {
  const s = new Stability({ holdMs: 1200 });
  assert.strictEqual(s.update(true, body(), 0), 0);
  assert.ok(s.update(true, body(0.005), 600) > 0.4);
  assert.strictEqual(s.update(true, body(0.005), 1200), 1);
});

test('人物移動或構圖跑掉就重新計時', () => {
  const s = new Stability({ holdMs: 1200 });
  s.update(true, body(), 0);
  s.update(true, body(), 900);
  assert.strictEqual(s.update(true, body(0.05), 1000), 0); // 動了
  assert.ok(s.update(true, body(0.05), 1600) < 1);
  assert.strictEqual(s.update(false, body(0.05), 1700), 0); // 構圖不 OK
  assert.strictEqual(s.update(true, null, 1800), 0);        // 沒偵測到人
});
