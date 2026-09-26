'use strict';

/*
 * 背景執行緒：美化繪製（背景虛化、美肌、小臉、瘦腰、長腿、調色）。
 * 放在這裡處理，拍照畫面和快門就不會被卡住。
 */
importScripts('retouch.js', 'beauty.js');

self.onmessage = async (e) => {
  const { id, bitmap, info, params } = e.data;
  try {
    const out = Beauty.render(bitmap, bitmap.width, bitmap.height, info, params);
    bitmap.close();
    const blob = await out.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
    self.postMessage({ id, blob });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
