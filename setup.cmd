@echo off
rem ============================================================
rem  DeepAI Phone Bridge - setup check (Windows)
rem  Runs once on a new PC and tells you if everything is ready.
rem ============================================================
setlocal
set "APP_DIR=%~dp0"

echo.
echo === DeepAI Phone Bridge setup check ===
echo.

rem --- 1. DeepAI Code desktop app (bundled Node runtime + server) ---
set "NODE_EXE=%LOCALAPPDATA%\Programs\deepai-code-desktop\DeepAI Code.exe"
if exist "%NODE_EXE%" (
  echo [ok]   DeepAI Code desktop app found.
) else (
  echo [warn] DeepAI Code desktop app not found at:
  echo         %NODE_EXE%
  echo         Install DeepAI Code and run it at least once, then retry.
)

rem --- 2. Node runtime (bundled one, or node on PATH) ---
where node >nul 2>&1
if %errorlevel%==0 (
  echo [ok]   node found on PATH.
) else if exist "%NODE_EXE%" (
  echo [ok]   Using the Node runtime bundled with DeepAI Code.
) else (
  echo [warn] No Node.js runtime found. Install Node.js LTS or DeepAI Code.
)

rem --- 3. DeepAI Code CLI ---
if exist "%USERPROFILE%\.deepai-code\bin\deepai.cmd" (
  echo [ok]   DeepAI Code CLI found.
) else (
  echo [warn] DeepAI Code CLI not found:
  echo         %USERPROFILE%\.deepai-code\bin\deepai.cmd
)

rem --- 4. Is the DeepAI Code server running on 127.0.0.1:3773 ? ---
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 3773 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>&1
if errorlevel 1 (
  echo [warn] Nothing is listening on 127.0.0.1:3773.
  echo         Start the DeepAI Code desktop app first.
) else (
  echo [ok]   DeepAI Code server is running on 127.0.0.1:3773.
)

rem --- 5. Firewall rule for the LAN port ---
powershell -NoProfile -Command "if (Get-NetFirewallRule -DisplayName 'DeepAI Phone Bridge' -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>&1
if errorlevel 1 (
  echo [info] Opening Windows Firewall for TCP 8787 ^(not required for private networks^)..
  powershell -NoProfile -Command "New-NetFirewallRule -DisplayName 'DeepAI Phone Bridge' -Direction Inbound -Protocol TCP -LocalPort 8787 -Action Allow -Profile Private -ErrorAction SilentlyContinue | Out-Null"
) else (
  echo [ok]   Firewall rule already exists.
)

echo.
echo === Next ===
echo   1. Start the DeepAI Code desktop app
echo   2. Run  app\start-bridge.cmd
echo   3. Scan the QR code with your phone on the same Wi-Fi
echo.
endlocal
pause
