@echo off
REM Double-click this file to update Sovereign and run it.
setlocal
cd /d "%~dp0"
title Sovereign

echo.
echo   Checking for updates...
where git >nul 2>nul
if errorlevel 1 (
  echo   Git isn't installed, so this copy can't update itself.
  echo   Continuing with the version already on disk.
) else (
  git pull --ff-only
  if errorlevel 1 (
    echo.
    echo   Couldn't update automatically - there are local edits in the way.
    echo   Starting the version already on disk instead.
    echo.
  )
)

echo   Checking dependencies...
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo.
  echo   npm install failed. Copy the message above and send it to Claude.
  echo.
  pause
  exit /b 1
)

REM open the browser once the server has had a moment to boot
start "" cmd /c "timeout /t 7 >nul & start http://localhost:5273"

echo.
if exist ".vercel" (
  echo   Starting Sovereign with bank sync enabled...
  echo   Leave this window open. Close it to stop the app.
  echo.
  call npx vercel dev --listen 5273
) else (
  echo   Starting Sovereign. Bank sync needs 'vercel dev' - see the README.
  echo   Leave this window open. Close it to stop the app.
  echo.
  call npm run dev
)

echo.
echo   Sovereign stopped.
pause
