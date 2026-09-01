@echo off
setlocal EnableExtensions EnableDelayedExpansion

for %%I in ("%~dp0..\..") do set "ROOT=%%~fI"
set "BRIDGE=%ROOT%\desktop\telegram_bridge"
set "BUILDROOT=%ROOT%\work\telegram-bridge-build"
set "VENV=%BUILDROOT%\venv"
set "OUT=%ROOT%\release\final"

if not exist "%BUILDROOT%" mkdir "%BUILDROOT%"
if not exist "%OUT%" mkdir "%OUT%"

set "PY=python"
where py >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  py -3.11 -c "import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 11) else 1)" >nul 2>nul
  if !ERRORLEVEL! EQU 0 (
    set "PY=py -3.11"
  ) else (
    py -V:Astral/CPython3.11.15 -c "import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 11) else 1)" >nul 2>nul
    if !ERRORLEVEL! EQU 0 set "PY=py -V:Astral/CPython3.11.15"
  )
)

if not exist "%VENV%\Scripts\python.exe" (
  echo [bridge 1/4] Creating isolated Python build environment...
  %PY% -m venv "%VENV%" || exit /b 1
)

echo [bridge 2/4] Installing pinned bridge build dependencies...
"%VENV%\Scripts\python.exe" -m pip install --disable-pip-version-check --quiet -r "%BRIDGE%\requirements.txt" || exit /b 1

echo [bridge 3/4] Building loopback-only Telegram Storage Bridge...
if exist "%BUILDROOT%\dist" rmdir /S /Q "%BUILDROOT%\dist"
if exist "%BUILDROOT%\pyinstaller" rmdir /S /Q "%BUILDROOT%\pyinstaller"
"%VENV%\Scripts\python.exe" -m PyInstaller ^
  --noconfirm --clean --onefile --noconsole ^
  --name TelegramStorageBridge ^
  --distpath "%BUILDROOT%\dist" ^
  --workpath "%BUILDROOT%\pyinstaller" ^
  --specpath "%BUILDROOT%" ^
  "%BRIDGE%\bridge.py" || exit /b 1

echo [bridge 4/4] Publishing bridge binary...
copy /Y "%BUILDROOT%\dist\TelegramStorageBridge.exe" "%OUT%\TelegramStorageBridge.exe" >nul || exit /b 1
for %%F in ("%OUT%\TelegramStorageBridge.exe") do echo [OK] %%~fF ^(%%~zF bytes^)
exit /b 0
