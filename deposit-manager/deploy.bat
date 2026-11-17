@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   訂金管理系統  部署到 Firebase
echo ============================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo [錯誤] 這台電腦還沒有安裝 Node.js。
  echo 請到 https://nodejs.org 下載 LTS 版安裝，裝好後重新雙擊這個檔案。
  pause
  exit /b 1
)
set /p PROJECT=請輸入 Firebase 專案 ID（例如 abc-love）： 
if "%PROJECT%"=="" (
  echo 沒有輸入專案 ID，已取消。
  pause
  exit /b 1
)
echo.
echo [1/2] 登入 Google 帳號（第一次會開啟瀏覽器，請用建立 Firebase 專案的帳號登入）
call npx --yes firebase-tools@13 login
if errorlevel 1 goto fail
echo.
echo [2/2] 上傳網站與安全規則到 %PROJECT%
call npx --yes firebase-tools@13 deploy --only hosting,firestore:rules --project %PROJECT%
if errorlevel 1 goto fail
echo.
echo ============================================
echo   完成！網址：https://%PROJECT%.web.app
echo ============================================
pause
exit /b 0
:fail
echo.
echo [失敗] 請把上面的畫面截圖給 Claude。
pause
exit /b 1
