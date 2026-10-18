// 以 Chromium 繪製 App 圖示與啟動畫面(assets/*.png),再交給 @capacitor/assets 產生各尺寸。
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const KEY = (extra = '') => `
  <g transform="translate(512 512) rotate(-45)" ${extra}>
    <path fill="#fff" fill-rule="evenodd" d="M-300 0a130 130 0 1 0 260 0a130 130 0 1 0 -260 0ZM-248 0a78 78 0 1 1 156 0a78 78 0 1 1 -156 0Z"/>
    <rect x="-50" y="-27" width="330" height="54" rx="27" fill="#fff"/>
    <rect x="170" y="10" width="44" height="86" rx="14" fill="#fff"/>
    <rect x="236" y="10" width="44" height="62" rx="14" fill="#fff"/>
    <circle cx="-170" cy="0" r="22" fill="#f2a93b"/>
  </g>`;
const GRAD = `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
  <stop offset="0" stop-color="#26325e"/><stop offset=".55" stop-color="#5a3a6b"/><stop offset="1" stop-color="#e8452c"/></linearGradient></defs>`;
const DARKGRAD = `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
  <stop offset="0" stop-color="#141b38"/><stop offset=".55" stop-color="#3a2a52"/><stop offset="1" stop-color="#b8331f"/></linearGradient></defs>`;

const wrap = (w, h, inner) =>
  `<html><body style="margin:0;background:transparent"><svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${inner}</svg></body></html>`;

const jobs = {
  'icon-only.png': [1024, 1024, `${GRAD}<rect width="1024" height="1024" fill="url(#g)"/>${KEY()}`, false],
  'icon-background.png': [1024, 1024, `${GRAD}<rect width="1024" height="1024" fill="url(#g)"/>`, false],
  'icon-foreground.png': [1024, 1024, KEY().replace('translate(512 512)', 'translate(512 512) scale(.85)'), true],
};
for (const [file, dark] of [['splash.png', false], ['splash-dark.png', true]]) {
  const scale = 0.8;
  jobs[file] = [2732, 2732, `${dark ? DARKGRAD : GRAD}<rect width="2732" height="2732" fill="url(#g)"/>
    <g transform="translate(${1366 - 512 * scale} ${1130 - 512 * scale}) scale(${scale})">${KEY()}</g>
    <text x="1366" y="1760" text-anchor="middle" font-size="210" font-weight="700" letter-spacing="40" fill="#fff" font-family="Noto Sans TC, Noto Sans JP, sans-serif">藍緋</text>`, false];
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
for (const [file, [w, h, inner, transparent]] of Object.entries(jobs)) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.setContent(wrap(w, h, inner));
  await page.screenshot({ path: `assets/${file}`, omitBackground: transparent });
  await page.close();
}
await browser.close();
console.log('assets done');
