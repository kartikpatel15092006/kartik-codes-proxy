@echo off
title Kartik Codes Proxy
cd /d "%~dp0"

echo ============================================
echo    KARTIK CODES PROXY
echo ============================================
echo.
echo   UI + API :  http://localhost:4000
echo   OpenCode :  model "kartik-proxy-codes"
echo.
echo   Keep this window OPEN while using OpenCode.
echo   Close this window to stop the proxy.
echo.

:: Install dependencies on first run
if not exist "node_modules" (
    echo First run - installing dependencies, please wait...
    call npm install
    echo.
)

:: Build UI if dist folder is missing (first run)
if not exist "dist\index.html" (
    echo First run - building UI, please wait...
    call npm run build
    echo.
)

echo Starting proxy...
echo.
node server\index.js

echo.
echo Proxy stopped.
pause
