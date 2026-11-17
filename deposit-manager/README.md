# 訂金管理系統（deposit-manager）

以 Firebase（Hosting＋Firestore＋Authentication，免費方案）管理店面訂金，取代現行的「客注品精算確認リスト」Excel。

- 設計書：[`docs/design.html`](docs/design.html)
- 程式：`public/`（網頁程式）、`firestore.rules`（安全規則）

## 功能

| 角色 | 可以做的事 |
| --- | --- |
| 店員 | 收訂金（自動配號）、追加訂金、標記到貨／已通知、取貨結帳（收尾款）、修改資料、搜尋、總表、列印收據、報表 |
| 會計 | 總表（接近 Excel 的排版）、勾選「轉記」（已轉到正式帳本）與「確認」（會計自己審核用）、報表、匯出 CSV。不能收款或修改訂金單 |
| 經理 | 店員與會計的全部功能，加上退訂（退還＋沒收）、作廢、人員管理、店鋪設定、資料檢查 |

「設定」可切換是否另外開立發票：開啟時顯示發票號碼欄位，關閉時只用本系統的收據編號。

## 驗證狀態

| 項目 | 狀態 |
| --- | --- |
| 金額運算與業務流程（`npm test`，13 項） | 通過 |
| 瀏覽器實際操作流程（`npm run test:ui`，示範模式，手機與電腦寬度） | 通過 |
| 連接 Firebase（`js/store-firebase.js`）與安全規則（`firestore.rules`） | **尚未驗證**，需建立 Firebase 專案後實機測試 |
| 自動部署（`.github/workflows/deploy-deposit-manager.yml`） | **尚未驗證**，第一次執行時確認 |
| 舊帳本匯入 | 尚未製作 |

## 先試用（示範模式）

不需要 Firebase。資料只存在瀏覽器，可隨意操作。

```
npm run serve     # 然後開啟 http://localhost:5174
```

## 正式安裝

### 一、建立 Firebase 專案（瀏覽器操作，約 5 分鐘）

1. 開啟 <https://console.firebase.google.com>，按「新增專案」，輸入名稱（例如 `naps-deposit`），Google Analytics 可關閉。
2. 左側「建構」→「Firestore Database」→「建立資料庫」。位置選 `asia-east1 (Taiwan)`，模式選「正式版模式」。
3. 左側「建構」→「Authentication」→「開始使用」→ 啟用「電子郵件／密碼」。
4. 同一頁的「Users」→「新增使用者」，輸入您自己的 Email 與密碼。這會是第一位經理。
5. 左上齒輪「專案設定」→「您的應用程式」→ 按網頁圖示 `</>` → 輸入暱稱並勾選「同時設定 Firebase Hosting」→ 註冊。

### 二、設定一鍵部署（只需做一次）

1. Firebase 主控台左上齒輪「專案設定」→「服務帳戶」→「產生新的私密金鑰」，會下載一個 JSON 檔。
2. 同一頁點「管理服務帳戶權限」進入 Google Cloud 的 IAM 頁面，找到名稱含 `firebase-adminsdk` 的帳戶，新增角色「Firebase 管理員」。
3. 到 GitHub 儲存庫的 Settings → Secrets and variables → Actions → New repository secret：
   名稱填 `FIREBASE_SERVICE_ACCOUNT`，內容貼上整個 JSON 檔的文字。
4. 這個 JSON 檔等同管理員鑰匙，貼完後請從電腦刪除，不要傳給任何人。

之後每次把 PR 按「Merge」合併到 main，就會自動測試並部署；也可以到 Actions 頁面手動按「Run workflow」。
部署完成後網址是 `https://<專案 ID>.web.app`。

不想用自動部署時，也可以在有 Node.js 的電腦上執行：

```
npm install -g firebase-tools
firebase login
cd deposit-manager
firebase deploy --only hosting,firestore:rules --project <專案 ID>
```

### 三、第一次登入

1. 開啟網址，用步驟一建立的 Email 與密碼登入。
2. 畫面會請您輸入姓名與店名，按「開始使用」後您就是經理。請在部署後立刻完成這一步。
3. 到「設定」分頁新增其他人員的帳號。

## 注意事項

- 免費方案沒有自動備份。請經理每週到「報表」分頁按「下載訂金單與收付明細」。
- 沒有被經理加入「人員」的帳號，即使註冊成功也無法讀寫任何資料。
- 收付明細不可修改或刪除。登打錯誤請用「作廢」後重新建立。
- 取貨結帳是整張單一次結清，不支援分批取貨。
