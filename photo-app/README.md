# 拍照 App

純前端的網頁拍照 App（PWA），手機、電腦瀏覽器都能用，可「加入主畫面」當成 App 使用。

## 功能
- 即時相機預覽，前／後鏡頭切換
- 6 種濾鏡（原圖、黑白、復古、鮮豔、柔亮、冷色）
- 倒數計時（關 / 3 秒 / 10 秒）、九宮格構圖線
- 相簿：照片存在瀏覽器（IndexedDB），可檢視、下載、分享、刪除
- 支援離線使用；電腦上可按空白鍵拍照

## 上線（GitHub Pages）
1. 將此分支合併到 `main`
2. 到 GitHub repo → **Settings → Pages → Source** 選 **GitHub Actions**
3. 之後每次 `photo-app/` 有變更，會自動部署到
   `https://<帳號>.github.io/naps-improvement-log/`

> 相機功能必須在 HTTPS（或 localhost）下才能使用，GitHub Pages 預設即為 HTTPS。

## 本機測試
```bash
cd photo-app
python3 -m http.server 8000
# 開啟 http://localhost:8000
```

## 注意
照片只存在該裝置的瀏覽器中，清除瀏覽器資料會一併刪除，重要照片請先下載。
