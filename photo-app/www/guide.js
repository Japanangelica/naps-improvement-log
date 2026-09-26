'use strict';

/*
 * 畫面上的構圖導引：人物骨架（依狀態變色）、腳底目標線、水平儀、方向提示。
 * cueFor()、Stability 為純邏輯，方便測試；draw() 需要瀏覽器的 canvas。
 */

const COLORS = { ok: '#3ecf6e', tip: '#ffcc00', warn: '#ff6b4a' };
const BONES = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [27, 31], [24, 26], [26, 28], [28, 32],
];
const FOOT_LINE = 0.97;   // 腳底目標線（畫面高度的比例）

/** 依提示代碼決定畫面上的方向提示：{dir: 'down'|'up'|'in'|'level', text} */
function cueFor(code) {
  switch (code) {
    case 'pitch': return { dir: 'down', text: '蹲低，手機微微往上' };
    case 'feet-far': return { dir: 'down', text: '手機往下移' };
    case 'headroom': return { dir: 'down', text: '手機往下壓' };
    case 'cut-feet':
    case 'feet-edge': return { dir: 'up', text: '退後一步' };
    case 'cut-head': return { dir: 'up', text: '退後一步' };
    case 'small': return { dir: 'in', text: '走近一點' };
    case 'tilt': return { dir: 'level', text: '把手機拿正' };
    default: return null;
  }
}

/**
 * 自動快門用：人物（肩膀與髖部中心）連續穩定且構圖 OK 達 holdMs 才觸發。
 */
class Stability {
  constructor({ holdMs = 1200, maxMove = 0.015 } = {}) {
    this.holdMs = holdMs;
    this.maxMove = maxMove;
    this.reset();
  }

  reset() {
    this.since = null;
    this.last = null;
  }

  static center(lm) {
    const idx = [11, 12, 23, 24];
    const x = idx.reduce((s, i) => s + lm[i].x, 0) / idx.length;
    const y = idx.reduce((s, i) => s + lm[i].y, 0) / idx.length;
    return { x, y };
  }

  /** 回傳 0–1 的進度；1 代表可以拍了 */
  update(ok, lm, now) {
    if (!ok || !lm) { this.reset(); return 0; }
    const c = Stability.center(lm);
    if (this.last && Math.hypot(c.x - this.last.x, c.y - this.last.y) > this.maxMove) this.since = null;
    this.last = c;
    if (this.since == null) this.since = now;
    return Math.min(1, (now - this.since) / this.holdMs);
  }
}

/**
 * 在 canvas 上畫導引。
 * @param {HTMLCanvasElement} canvas 與預覽框同大小
 * @param {object} o
 * @param {Array|null} o.lm 骨架（相對預覽框 0–1）
 * @param {boolean} o.mirror 前鏡頭時左右翻轉
 * @param {{level:string, code:string, body:object|null}} o.hint
 * @param {number|null} o.roll 手機順時針歪斜角度（度），null 表示不知道
 */
function draw(canvas, { lm, mirror, hint, roll }) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!hint) return;

  const color = COLORS[hint.level] || COLORS.tip;
  const X = (p) => (mirror ? 1 - p.x : p.x) * w;
  const Y = (p) => p.y * h;
  const seen = (i) => lm && lm[i] && lm[i].visibility >= 0.5;

  // 腳底目標線：拍全身時才顯示
  const body = hint.body;
  if (body && (body.feetVisible || body.kneesVisible)) {
    const good = body.feetVisible && body.feetY >= 0.88 && body.feetY <= 0.99;
    const y = FOOT_LINE * h;
    ctx.save();
    ctx.setLineDash([10, 8]);
    ctx.lineWidth = 3;
    ctx.strokeStyle = good ? COLORS.ok : 'rgba(255,255,255,.85)';
    ctx.beginPath();
    ctx.moveTo(w * 0.12, y);
    ctx.lineTo(w * 0.88, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = '600 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = good ? COLORS.ok : '#fff';
    ctx.shadowColor = 'rgba(0,0,0,.7)';
    ctx.shadowBlur = 4;
    ctx.fillText(good ? '腳底位置剛好 ✓' : '腳底放在這條線', w / 2, y - 8);
    ctx.restore();
  }

  // 人物骨架
  if (lm) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineWidth = 4;
    ctx.strokeStyle = color;
    ctx.shadowColor = 'rgba(0,0,0,.5)';
    ctx.shadowBlur = 3;
    ctx.globalAlpha = 0.85;
    for (const [a, b] of BONES) {
      if (!seen(a) || !seen(b)) continue;
      ctx.beginPath();
      ctx.moveTo(X(lm[a]), Y(lm[a]));
      ctx.lineTo(X(lm[b]), Y(lm[b]));
      ctx.stroke();
    }
    if (seen(0)) {
      ctx.beginPath();
      ctx.arc(X(lm[0]), Y(lm[0]), 6, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
    ctx.restore();
  }

  // 水平儀：歪斜時顯示真正的水平線
  if (roll != null && Math.abs(roll) > 2) {
    const level = Math.abs(roll) <= 4;
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate(-roll * Math.PI / 180);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = level ? COLORS.ok : COLORS.warn;
    ctx.beginPath();
    ctx.moveTo(-w * 0.3, 0);
    ctx.lineTo(-24, 0);
    ctx.moveTo(24, 0);
    ctx.lineTo(w * 0.3, 0);
    ctx.stroke();
    ctx.restore();
    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(255,255,255,.6)';
    ctx.beginPath();
    ctx.moveTo(w / 2 - 18, h / 2);
    ctx.lineTo(w / 2 + 18, h / 2);
    ctx.stroke();
    ctx.restore();
  }
}

const Guide = { cueFor, Stability, draw, FOOT_LINE };
if (typeof module !== 'undefined') module.exports = Guide;
else self.Guide = Guide;
