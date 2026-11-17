// 以真實瀏覽器在示範模式走過主要流程：npm run test:ui
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const PORT = 5181, shots = process.env.SHOTS;
const server = spawn(process.execPath, ['tools/serve.mjs'], { env: { ...process.env, PORT }, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 600));
const browser = await chromium.launch();
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/init\.json|404/.test(m.text())) errors.push(m.text()); });
  const shot = async n => { if (shots) await page.screenshot({ path: `${shots}/${n}.png`, fullPage: true }); };
  const act = a => page.click(`[data-act="${a}"]`);

  await page.goto(`http://localhost:${PORT}/`);
  await page.click('[data-act="demoLogin"][data-email="manager@demo"]');
  await page.waitForSelector('.order');
  assert.equal(await page.locator('.order').count(), 3);
  await shot('1-home');

  // 收訂金：缺支付方式時要有明確錯誤，補上後成功
  await act('new');
  await page.fill('#fPhone', '0911-222-333'); await page.fill('#fName', '測試 客戶');
  await page.fill('#items .nm', 'SHOEI Z-8'); await page.fill('#items .sp', 'M 黑'); await page.fill('#items .pr', '18000');
  await page.click('[data-act="quick"][data-v="0.5"]');
  assert.equal(await page.inputValue('#fAmt'), '9000');
  await act('submitForm');
  await page.waitForSelector('#formErr .err');
  assert.match(await page.textContent('#formErr'), /支付方式/);
  await page.click('[data-group="method"] .opt[data-v="銀行轉帳"]');
  assert.ok(await page.isVisible('.transfer'));
  await shot('2-form');
  await act('submitForm');
  await page.waitForSelector('.done-no');
  const orderNo = (await page.textContent('.done-no')).trim();
  assert.match(orderNo, /^DP-\d{6}-004$/);
  await shot('3-done');

  // 首頁搜尋 → 明細 → 到貨 → 通知 → 取貨結帳
  await act('home');
  await page.fill('#q', '222333');
  assert.equal(await page.locator('#list .order').count(), 1);
  await page.click('#list .order');
  await page.waitForSelector('[data-act="stage"][data-v="arrived"]');
  await shot('4-detail');
  await page.click('[data-act="stage"][data-v="arrived"]');
  await page.waitForSelector('[data-act="stage"][data-v="notified"]');
  await page.click('[data-act="stage"][data-v="notified"]');
  await page.waitForSelector('.pill.notified');
  await act('mClose');
  assert.equal((await page.textContent('#mTail')).trim(), '$9,000');
  await act('doClose');
  await page.waitForSelector('#mErr .err');           // 沒選尾款支付方式
  await page.click('#modalBody [data-group="method"] .opt[data-v="信用卡"]');
  await shot('5-close');
  await act('doClose');
  await page.waitForSelector('.pill.closed');
  assert.equal(await page.locator('table tr:has-text("尾款")').count(), 1);
  await shot('6-closed');

  // 退訂：退 600、沒收 400
  await act('back'); await page.fill('#q', '');
  await page.click('.order:has-text("陳小姐")');
  await page.waitForSelector('[data-act="mCancel"]');
  await act('mCancel');
  await page.fill('#mRefund', '600');
  assert.equal((await page.textContent('#mForfeit')).trim(), '$400');
  await page.fill('#mReason', '客戶改變心意');
  await act('doCancel');
  await page.waitForSelector('.pill.refunded');

  // 報表：實收 9000＋9000、退款 600；示範種子另有 3000＋1000＋8800
  await page.click('[data-act="tab"][data-v="report"]');
  await page.waitForSelector('#rOut .money');
  const rep = await page.textContent('#rOut');
  assert.ok(rep.includes('$30,800'), '實收應為 30,800'); assert.ok(rep.includes('$30,200'), '淨收應為 30,200');
  await shot('7-report');
  await page.click('[data-act="tab"][data-v="settings"]');
  await page.waitForSelector('#staffList table');
  await act('integrity');
  await page.waitForSelector('#chkOut .pill');
  assert.match(await page.textContent('#chkOut'), /全部一致/);
  await shot('8-settings');

  // 店員：沒有設定分頁與經理功能；重新整理後資料仍在
  await act('logout');
  await page.reload();
  await page.click('[data-act="demoLogin"][data-email="staff@demo"]');
  await page.waitForSelector('.order');
  assert.equal(await page.locator('.order').count(), 2);
  assert.equal(await page.locator('[data-act="tab"][data-v="settings"]').count(), 0);
  await page.click('.order');
  await page.waitForSelector('[data-act="mClose"]');
  assert.equal(await page.locator('[data-act="mCancel"], [data-act="mVoid"]').count(), 0);

  // 會計：預設進總表，只能轉記，不能收款
  await act('logout');
  await page.setViewportSize({ width: 1366, height: 800 });
  await page.click('[data-act="demoLogin"][data-email="accountant@demo"]');
  await page.waitForSelector('#sheet tbody tr');
  assert.equal(await page.locator('#sheet tbody tr').count(), 4);
  assert.equal(await page.locator('[data-act="tab"][data-v="home"]').count(), 0);
  await page.check(`[data-post="${orderNo}"][data-flag="posted"]`);
  await page.waitForSelector('#toast:has-text("已勾選轉記")');
  await page.check(`[data-post="${orderNo}"][data-flag="reviewed"]`);
  await page.waitForSelector('#toast:has-text("已勾選會計確認")');
  await page.selectOption('#tStatus', 'unreviewed'); await act('tableLoad');
  await page.waitForFunction(() => document.querySelectorAll('#sheet tbody tr').length === 3);
  await page.selectOption('#tStatus', 'unposted'); await act('tableLoad');
  await page.waitForFunction(() => document.querySelectorAll('#sheet tbody tr').length === 3);
  await page.selectOption('#tStatus', 'all'); await act('tableLoad');
  await page.waitForFunction(() => document.querySelectorAll('#sheet tbody tr').length === 4);
  await page.fill('#tq', 'shoei');
  assert.equal(await page.locator('#sheet tbody tr').count(), 1);
  await page.fill('#tq', '');
  await shot('10-sheet');
  await page.click(`#sheet tr[data-no="${orderNo}"] td:nth-child(4)`);
  await page.waitForSelector('[data-act="flag"]');
  assert.equal(await page.locator('[data-act="mClose"], [data-act="mPay"], [data-act="mVoid"], [data-act="edit"]').count(), 0);
  await shot('11-detail-desktop');
  await act('back'); await page.waitForSelector('#sheet tbody tr');
  await act('logout');
  await page.click('[data-act="demoLogin"][data-email="staff@demo"]');

  // 桌面寬度截圖
  await page.waitForSelector('.order'); await shot('9-desktop');
  assert.deepEqual(errors, []);
  console.log('UI 流程測試通過');
} finally { await browser.close(); server.kill(); }
