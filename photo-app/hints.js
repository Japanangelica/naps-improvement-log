'use strict';

/*
 * 拍照即時提示：根據「畫面亮度、手機姿態、人物骨架」判斷目前構圖，
 * 回傳最優先的一則建議。analyze() 為純函式，方便測試。
 */

// MediaPipe Pose 關鍵點索引
const LM = {
  NOSE: 0, L_EYE: 2, R_EYE: 5, MOUTH_L: 9, MOUTH_R: 10,
  L_SHOULDER: 11, R_SHOULDER: 12, L_HIP: 23, R_HIP: 24,
  L_KNEE: 25, R_KNEE: 26, L_ANKLE: 27, R_ANKLE: 28,
  L_HEEL: 29, R_HEEL: 30, L_FOOT: 31, R_FOOT: 32,
};

const VISIBLE = 0.5;

function seen(lm, ...idx) {
  return idx.some((i) => lm[i] && lm[i].visibility >= VISIBLE && lm[i].y >= 0 && lm[i].y <= 1);
}
function maxY(lm, ...idx) {
  return Math.max(...idx.map((i) => lm[i].y));
}

/** 從骨架推算人物在畫面中的位置（0 = 畫面頂端，1 = 底端） */
function describePose(lm) {
  const eyeY = (lm[LM.L_EYE].y + lm[LM.R_EYE].y) / 2;
  const mouthY = (lm[LM.MOUTH_L].y + lm[LM.MOUTH_R].y) / 2;
  // 頭頂約在眼睛上方「眼到嘴距離」的 1.6 倍
  const headTop = eyeY - Math.max(mouthY - eyeY, 0.01) * 1.6;
  const feetVisible = seen(lm, LM.L_ANKLE, LM.R_ANKLE);
  const kneesVisible = seen(lm, LM.L_KNEE, LM.R_KNEE);
  const feetY = maxY(lm, LM.L_ANKLE, LM.R_ANKLE, LM.L_HEEL, LM.R_HEEL, LM.L_FOOT, LM.R_FOOT);
  const bottomY = feetVisible ? feetY : kneesVisible ? maxY(lm, LM.L_KNEE, LM.R_KNEE) : maxY(lm, LM.L_HIP, LM.R_HIP);
  return {
    headTop,
    feetY,
    feetVisible,
    kneesVisible,
    height: bottomY - headTop,
  };
}

/**
 * @param {object} input
 * @param {{mean:number, center:number, edges:number}} [input.light] 亮度 0–255
 * @param {{tilt:number, pitchDown:number|null}} [input.motion] 角度（度）
 * @param {Array<{x:number,y:number,visibility:number}>|null} [input.pose]
 * @returns {{level:'warn'|'tip'|'ok', text:string}}
 */
function analyze({ light, motion, pose } = {}) {
  const hints = [];
  const add = (priority, level, text) => hints.push({ priority, level, text });

  if (light) {
    if (light.mean < 55) add(1, 'warn', '太暗了：找亮一點的地方，或讓她面向光源');
    else if (light.edges > 170 && light.center < light.edges * 0.6) {
      add(8, 'tip', '背光了：臉會黑黑的，換個方向讓光打在她臉上');
    }
  }

  if (motion) {
    if (motion.tilt > 4) add(4, 'warn', `手機歪了 ${Math.round(motion.tilt)}°：拿正，水平線才不會斜`);
    if (motion.pitchDown != null && motion.pitchDown > 15) {
      add(5, 'warn', '別從上往下拍！蹲低、手機放腰部高度，微微往上拍，腿會變長');
    }
  }

  if (pose) {
    const p = describePose(pose);
    if (p.headTop < 0) add(2, 'warn', '頭被切到了：往後退一步，或手機往上一點');
    if (!p.feetVisible && p.kneesVisible) {
      add(3, 'warn', '腳被切到了：要嘛把腳底完整拍進來，要嘛只拍到大腿，別切在腳踝或小腿');
    }
    if (p.feetVisible && p.feetY > 0.99) add(3, 'warn', '腳底快出畫面了：手機往上一點點，把腳完整拍進來');
    if (p.feetVisible && p.feetY < 0.85) {
      add(6, 'tip', '腳底離畫面下緣太遠：讓腳底貼近下緣，腿看起來更長');
    }
    if (p.feetVisible && p.headTop > 0.4) add(7, 'tip', '頭頂上方空太多：手機往下壓一點，或走近一點');
    if (p.height < 0.3) add(9, 'tip', '人太小了：走近一點，讓她占畫面多一點');
  }

  hints.sort((a, b) => a.priority - b.priority);
  if (hints.length) return hints[0];
  return pose
    ? { level: 'ok', text: '構圖不錯，可以拍了！記得多拍幾張' }
    : { level: 'tip', text: '把她放進畫面，我會幫你看構圖' };
}

/** 計算畫面亮度：整體、中央、四周 */
function measureLight(ctx, w, h) {
  const { data } = ctx.getImageData(0, 0, w, h);
  let all = 0, center = 0, edges = 0, nc = 0, ne = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      all += l;
      const inCenter = x > w * 0.3 && x < w * 0.7 && y > h * 0.2 && y < h * 0.6;
      if (inCenter) { center += l; nc++; } else { edges += l; ne++; }
    }
  }
  return { mean: all / (w * h), center: center / nc, edges: edges / ne };
}

/** 由重力方向算出手機歪斜角度（不分直拿橫拿） */
function tiltFromGravity(g) {
  if (!g || g.x == null) return null;
  const a = Math.atan2(Math.abs(g.x), Math.abs(g.y)) * 180 / Math.PI;
  return Math.min(a, 90 - a);
}

/** 直拿時，鏡頭朝下的角度（deviceorientation 的 beta：90 = 直立） */
function pitchDownFromBeta(beta, portrait) {
  if (beta == null || !portrait) return null;
  return 90 - beta;
}

const Hints = { analyze, describePose, measureLight, tiltFromGravity, pitchDownFromBeta, LM };
if (typeof module !== 'undefined') module.exports = Hints;
else self.Hints = Hints;
