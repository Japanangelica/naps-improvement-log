# 拍照 App

純前端的網頁拍照 App（PWA），手機、電腦瀏覽器都能用，可「加入主畫面」當成 App 使用。

## 功能
- **✨ 自動美化**：拍完自動調亮、提升氣色，並偵測腰部位置、只把腰部以下拉長（預設 +8%，可用滑桿 0～15% 調整；按住照片可看原圖）
- **畫面構圖導引**：畫出人物骨架（綠＝OK、黃＝建議、紅＝要修正）、「腳底放在這條線」目標線、水平儀，以及「↓ 手機往下移」等方向提示
- **自動快門**：開啟「自動」後，構圖 OK 且她站穩 1.2 秒就自動拍，快門外圈會顯示倒數進度
- **💡 即時構圖提示**（全部在手機上判斷，不上傳、免費）
  - 手機往下俯拍 →「蹲低、微微往上拍，腿會變長」
  - 手機歪斜、畫面太暗、背光
  - 人物偵測（MediaPipe Pose）：頭或腳被切到、腳底離下緣太遠、頭頂留白太多、人太小
- **📖 拍照教學**：整理網路上「男友幫女友拍照」的常見技巧，附參考資料
- **連拍**：一次 5 張，讓她自己挑
- 即時相機預覽，前／後鏡頭切換
- 6 種濾鏡（原圖、黑白、復古、鮮豔、柔亮、冷色）
- 倒數計時（關 / 3 秒 / 10 秒）、九宮格構圖線
- 相簿：照片存在瀏覽器（IndexedDB），可檢視、下載、分享、刪除
- 支援離線使用；電腦上可按空白鍵拍照

## 三星 Galaxy 手機特化
建議用 **Chrome** 開啟（三星網際網路瀏覽器也能用，但鏡頭控制功能較少）。
- **多鏡頭切換**：超廣角／主鏡頭／望遠，按「鏡頭 1/3」輪流切換
- **變焦**：0.6x / 1x / 2x / 4x 按鈕，也可以雙指縮放
- **點畫面對焦**，並顯示對焦框
- **🔦 補光燈**：太暗時提示會建議開啟
- **4:3 預覽**：跟三星相機一樣，預覽畫面就是實際拍到的範圍
- 拍照時螢幕不會自動變暗；按快門時手機會輕微震動
- 提供 PNG 圖示，可以「加到主畫面」當成 App 使用

以上功能都會先檢查手機是否支援，不支援的按鈕會自動隱藏。

### S24 Ultra 調整
- 變焦段位對齊三星相機：0.6x / 1x / 2x / 3x / 5x / 10x（依手機提供的變焦範圍顯示）
- 要求最高 4000×3000 解析度（實際由 Chrome 決定，可在「📖 → 相機資訊」查看）
- 畫面比例切換：原始 / 3:4 / 9:16（限時動態）/ 1:1（貼文），預覽與照片、構圖提示都會依比例裁切
- 按鈕縮短，適合 S24 Ultra 預設約 384px 寬的畫面
- 教學頁新增「S24 Ultra 專屬小技巧」（各焦段怎麼用）
- 教學頁最下方的「相機資訊」可一鍵複製，方便回報問題、針對機型調整

## 上線（GitHub Pages）
1. 將此分支合併到 `main`
2. 到 GitHub repo → **Settings → Pages → Source** 選 **GitHub Actions**
3. 之後每次 `photo-app/` 有變更，會自動部署到
   `https://japanangelica.github.io/naps-improvement-log/`

> 相機功能必須在 HTTPS（或 localhost）下才能使用，GitHub Pages 預設即為 HTTPS。

## 下載 APK（Android App）
合併到 `main` 後，GitHub Actions 會自動編譯 APK，並放到固定的下載網址：

**https://github.com/Japanangelica/naps-improvement-log/releases/latest/download/photo-app.apk**

安裝方式（S24 Ultra）：
1. 用手機的 Chrome 打開上面的網址，下載 `photo-app.apk`
2. 點開下載的檔案 → 若出現「基於安全性考量…」，按「設定」→ 開啟「允許此來源」
3. 按「安裝」→ 打開 App → 允許相機權限

APK 版和網頁版功能相同，差別是：
- 全螢幕、沒有網址列，桌面上就是一個 App
- 「下載」會把照片存到 **我的檔案 → 文件 → 拍照App**；「分享」可直接傳到 LINE、IG、相簿等
- 人物偵測模型第一次使用時仍需要網路下載

### 簽署金鑰（建議設定，只需一次）
沒有設定時，APK 會用暫時的 debug 金鑰簽署，**每次更新都要先解除安裝舊版**（App 裡的照片會一起刪除）。
設定正式金鑰後就能直接覆蓋更新。到 repo 的 **Settings → Secrets and variables → Actions → New repository secret** 新增 4 個：

| 名稱 | 內容 |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | keystore 檔案的 base64 文字 |
| `ANDROID_KEYSTORE_PASSWORD` | keystore 密碼 |
| `ANDROID_KEY_ALIAS` | 金鑰別名 |
| `ANDROID_KEY_PASSWORD` | 金鑰密碼 |

> 這個 repo 是公開的，金鑰檔案和密碼**絕對不要**放進程式碼裡，只放在 Secrets。

## 專案結構
```
photo-app/
├── www/                 網頁本體（GitHub Pages 與 APK 共用）
├── android/             Capacitor 產生的 Android 專案
├── capacitor.config.json
└── tests/               單元測試
```

## 本機測試
```bash
cd photo-app
python3 -m http.server 8000 --directory www
# 開啟 http://localhost:8000
```

## 測試
```bash
cd photo-app
npm install
npm test   # 構圖提示邏輯的單元測試
```

## 注意
- 人物偵測模型（約 6 MB）第一次使用時從網路下載，之後會快取；載入失敗時仍會提供亮度與角度提示。
- iPhone 第一次點畫面時會詢問「動作與方向」權限，請允許，才能使用角度提示。

照片只存在該裝置的瀏覽器中，清除瀏覽器資料會一併刪除，重要照片請先下載。
