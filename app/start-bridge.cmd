@echo off
rem ============================================================
rem  DeepAI Phone Bridge launcher (Windows)
rem  Control the PC's DeepAI Code from a phone on the same Wi-Fi.
rem ============================================================
setlocal EnableDelayedExpansion
set "APP_DIR=%~dp0"

if "%DEEPAI_BASE_URL%"=="" set "DEEPAI_BASE_URL=http://127.0.0.1:3773"
if "%PORT%"=="" set "PORT=8787"
set "PORT_DEEP=3773"

rem --- Access token: reuse the saved one, or issue a new one ---
if "%DEEPAI_TOKEN%"=="" (
  if exist "%USERPROFILE%\.deepai-code\phone-bridge.token" (
    set /p DEEPAI_TOKEN=<"%USERPROFILE%\.deepai-code\phone-bridge.token"
  ) else (
    echo [info] issuing an access token...
    call "%USERPROFILE%\.deepai-code\bin\deepai.cmd" auth session issue --token-only --ttl 90d --label phone-bridge > "%TEMP%\dcp_token.txt" 2>nul
    set /p DEEPAI_TOKEN=<"%TEMP%\dcp_token.txt"
    del "%TEMP%\dcp_token.txt" >nul 2>&1
    >"%USERPROFILE%\.deepai-code\phone-bridge.token" echo(!DEEPAI_TOKEN!
  )
)
if "!DEEPAI_TOKEN!"=="" (
  echo [error] could not obtain an access token.
  echo         Run: "%USERPROFILE%\.deepai-code\bin\deepai.cmd" auth session issue --token-only --ttl 90d
  pause
  exit /b 1
)

rem --- Node runtime: prefer the one bundled with the DeepAI Code app ---
set "NODE_EXE=%LOCALAPPDATA%\Programs\deepai-code-desktop\DeepAI Code.exe"
if not exist "%NODE_EXE%" (
  where node >nul 2>&1
  if errorlevel 1 (
    echo [error] No Node.js runtime found.
    echo         Install Node.js LTS, or install the DeepAI Code desktop app.
    pause
    exit /b 1
  )
  set "NODE_EXE=node"
  set "NODE_ELECTRON="
) else (
  set "NODE_ELECTRON=1"
)

rem --- Check that the DeepAI Code server is running on the expected port ---
powershell -NoProfile -Command "if (-not (Get-NetTCPConnection -LocalPort %PORT_DEEP% -State Listen -ErrorAction SilentlyContinue)) { exit 1 }" >nul 2>&1
if errorlevel 1 (
  echo [warn] DeepAI Code server does not seem to be running on 127.0.0.1:%PORT_DEEP%
  echo [warn] Start the DeepAI Code desktop app first, then run this script again.
)

if defined NODE_ELECTRON set ELECTRON_RUN_AS_NODE=1
echo [start] DeepAI phone bridge on port %PORT%
echo [info] The phone will show the real DeepAI Code screen.
"%NODE_EXE%" "%APP_DIR%server.mjs"
endlocal