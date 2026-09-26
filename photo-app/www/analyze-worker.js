/*
 * 背景執行緒：拍照後的 AI 分析（人物骨架、臉部特徵與表情、人物分割、清晰度）。
 * 放在這裡跑，主畫面的相機與快門完全不會被卡住。
 */
/* global importScripts */
'use strict';

// MediaPipe 在 Worker 裡需要 importScripts，所以用一般（classic）Worker 載入 CommonJS 版本
self.exports = {};
importScripts('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.cjs', 'retouch.js', 'beauty.js');
const { FilesetResolver, PoseLandmarker, FaceLandmarker, ImageSegmenter } = self.exports;

const MP_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MODELS = {
  pose: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  face: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  seg: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite',
};

const models = {};

const ready = (async () => {
  const fileset = await FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
  const opts = (path, delegate) => ({ baseOptions: { modelAssetPath: path, delegate }, runningMode: 'IMAGE' });
  const withFallback = (make) => make('GPU').catch(() => make('CPU'));
  models.pose = await withFallback((d) => PoseLandmarker.createFromOptions(fileset, { ...opts(MODELS.pose, d), numPoses: 1 }));
  models.face = await withFallback((d) => FaceLandmarker.createFromOptions(fileset, {
    ...opts(MODELS.face, d), numFaces: 1, outputFaceBlendshapes: true,
  }));
  models.segmenter = await withFallback((d) => ImageSegmenter.createFromOptions(fileset, {
    ...opts(MODELS.seg, d), outputCategoryMask: true, outputConfidenceMasks: false,
  }));
})();

ready.then(
  () => self.postMessage({ type: 'ready' }),
  (err) => self.postMessage({ type: 'failed', error: String(err?.message || err) }),
);

self.onmessage = async (e) => {
  const { id, bitmap } = e.data;
  try {
    await ready;
    // 骨架：模型只需要 256px
    const k = 256 / Math.max(bitmap.width, bitmap.height);
    const small = new OffscreenCanvas(Math.round(bitmap.width * k), Math.round(bitmap.height * k));
    small.getContext('2d').drawImage(bitmap, 0, 0, small.width, small.height);
    const lm = models.pose.detect(small).landmarks?.[0];
    const info = {
      anchors: lm ? Retouch.poseAnchors(lm) : null,
      framing: lm ? Retouch.poseFraming(lm) : null,
      ...Beauty.analyze(bitmap, models),
    };
    bitmap.close();
    self.postMessage({ type: 'result', id, info });
  } catch (err) {
    self.postMessage({ type: 'result', id, error: String(err?.message || err) });
  }
};
