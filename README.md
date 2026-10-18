# 藍緋(あいひ)

離線密碼帳號記錄 App(Android)。名稱取自「藍」與「緋」兩色。

- 一筆記錄 = 名稱 + 一組帳號 + 一組密碼 + 備註
- 即時搜尋(名稱、帳號、備註;密碼不納入搜尋)
- 主密碼鎖 + 指紋解鎖,閒置自動上鎖
- 資料以 AES-256-GCM 加密(金鑰由主密碼經 PBKDF2-SHA256 / 600,000 次衍生),只存在手機本機
- 完全離線:App 不要求網路權限,並關閉 Android 系統備份
- 防截圖/隱藏多工預覽、複製後 30 秒清除剪貼簿
- 匯出/匯入加密備份檔(換手機用)
- 隨機密碼產生器、淺色/深色主題

> 忘記主密碼無法復原資料,請定期匯出備份。

## 取得 APK

推送到 GitHub 後,`Build APK` 工作流程會自動打包:
Actions → 最新一次執行 → Artifacts → `aihi-apk`,下載後把 `aihi.apk` 傳到手機安裝
(需允許「安裝未知來源 App」)。

APK 使用 repo 內固定的簽章金鑰(`android/app/aihi.keystore`),所以新版本可直接覆蓋安裝、保留資料。
這把金鑰僅供個人自用;若要公開發佈,請改用自己的私密金鑰並以 GitHub Secrets 提供。

## 開發

```bash
npm install
npm run dev          # 瀏覽器預覽(指紋與防截圖僅 Android 可用)
npm run build        # 打包網頁
npx cap sync android # 同步到 Android 專案
```

本機打包 APK 需要 JDK 21 與 Android SDK:`cd android && ./gradlew assembleRelease`。

重新產生圖示/啟動畫面:`node scripts/make-assets.mjs`(需要 playwright 與 Chromium),
再執行 `npx capacitor-assets generate --android --iconBackgroundColor '#26325e' --splashBackgroundColor '#26325e' --splashBackgroundColorDark '#141b38'`。
