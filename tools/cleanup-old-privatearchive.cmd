@echo off
setlocal EnableExtensions
chcp 65001 >nul

set "PROJECT=D:\wendangcodex\Codex2\telegram-private-media-vault"
set "FINAL=%PROJECT%\release\final\PrivateArchive.exe"
set "SETUP=%PROJECT%\release\final\PrivateArchive-Setup.exe"
set "INSTALLED=%LOCALAPPDATA%\Programs\PrivateArchive\PrivateArchive.exe"
set "LOG=%USERPROFILE%\Desktop\PrivateArchive-cleanup.log"

echo ================================================== > "%LOG%"
echo Private Archive one-time cleanup >> "%LOG%"
echo %DATE% %TIME% >> "%LOG%"
echo ================================================== >> "%LOG%"

echo [1/6] Verifying release and installed build...
if not exist "%FINAL%" (
  echo ERROR: latest release not found: "%FINAL%" >> "%LOG%"
  echo 未找到 release\final 最新版，已停止清理。
  goto :fail
)
if not exist "%SETUP%" (
  echo ERROR: latest setup not found: "%SETUP%" >> "%LOG%"
  echo 未找到 release\final 安装器，已停止清理。
  goto :fail
)
if not exist "%INSTALLED%" (
  echo INFO: installed exe not found; latest setup will be installed first. >> "%LOG%"
)

for /f "tokens=*" %%H in ('powershell -NoProfile -Command "(Get-FileHash -LiteralPath '%FINAL%' -Algorithm SHA256).Hash"') do set "FINAL_HASH=%%H"
set "INSTALLED_HASH=MISSING"
if exist "%INSTALLED%" for /f "tokens=*" %%H in ('powershell -NoProfile -Command "(Get-FileHash -LiteralPath '%INSTALLED%' -Algorithm SHA256).Hash"') do set "INSTALLED_HASH=%%H"

echo FINAL_HASH=%FINAL_HASH% >> "%LOG%"
echo INSTALLED_HASH=%INSTALLED_HASH% >> "%LOG%"

if /I not "%FINAL_HASH%"=="%INSTALLED_HASH%" (
  echo [2/6] Installed build is older or missing. Upgrading first...
  echo UPGRADE_REQUIRED >> "%LOG%"
  tasklist /FI "IMAGENAME eq PrivateArchive.exe" 2>nul | find /I "PrivateArchive.exe" >nul
  if not errorlevel 1 (
    echo Closing PrivateArchive.exe before upgrade... >> "%LOG%"
    taskkill /IM PrivateArchive.exe /T >nul 2>&1
    timeout /t 2 /nobreak >nul
  )
  start "" /wait "%SETUP%" /silent
  if errorlevel 1 (
    echo ERROR: setup returned failure >> "%LOG%"
    echo 自动升级失败，已停止清理。
    goto :fail
  )
) else (
  echo [2/6] Installed build already matches latest release.
)

echo [3/6] Re-verifying exact SHA256 before deletion...
if not exist "%INSTALLED%" goto :fail
for /f "tokens=*" %%H in ('powershell -NoProfile -Command "(Get-FileHash -LiteralPath '%FINAL%' -Algorithm SHA256).Hash"') do set "FINAL_HASH_NOW=%%H"
for /f "tokens=*" %%H in ('powershell -NoProfile -Command "(Get-FileHash -LiteralPath '%INSTALLED%' -Algorithm SHA256).Hash"') do set "INSTALLED_HASH_NOW=%%H"
echo FINAL_HASH_NOW=%FINAL_HASH_NOW% >> "%LOG%"
echo INSTALLED_HASH_NOW=%INSTALLED_HASH_NOW% >> "%LOG%"
if /I not "%FINAL_HASH_NOW%"=="%INSTALLED_HASH_NOW%" (
  echo ERROR: installed build still does not match release\final >> "%LOG%"
  echo 最新版仍未安装一致，已停止清理，未删除任何旧构建。
  goto :fail
)

echo [4/6] Cleaning duplicate files in release root...
for %%F in (
  "PrivateArchive.exe"
  "PrivateArchive-Local.exe"
  "PrivateArchive-Uninstall.exe"
  "PrivateArchive-Setup.exe"
  "PrivateArchive-Windows-v0.1.0.zip"
  "README.txt"
  "SHA256SUMS.txt"
  "LOCAL-SHA256.txt"
  "ZIP-SHA256.txt"
) do (
  if exist "%PROJECT%\release\%%~F" (
    echo DELETE release\%%~F >> "%LOG%"
    del /f /q "%PROJECT%\release\%%~F" >> "%LOG%" 2>&1
  )
)

echo [5/6] Cleaning rebuildable test/build output...
for %%D in (
  "%PROJECT%\dist"
  "%PROJECT%\test-results"
  "%PROJECT%\playwright-report"
  "%PROJECT%\.wrangler\e2e-state"
) do (
  if exist "%%~D" (
    echo DELETE DIR %%~D >> "%LOG%"
    rmdir /s /q "%%~D" >> "%LOG%" 2>&1
  )
)

echo [6/6] Final safety verification...
if not exist "%FINAL%" goto :fail
if not exist "%INSTALLED%" goto :fail
for /f "tokens=*" %%H in ('powershell -NoProfile -Command "(Get-FileHash -LiteralPath '%FINAL%' -Algorithm SHA256).Hash"') do set "FINAL_HASH_AFTER=%%H"
for /f "tokens=*" %%H in ('powershell -NoProfile -Command "(Get-FileHash -LiteralPath '%INSTALLED%' -Algorithm SHA256).Hash"') do set "INSTALLED_HASH_AFTER=%%H"
if /I not "%FINAL_HASH_AFTER%"=="%INSTALLED_HASH_AFTER%" goto :fail

echo KEEP %PROJECT%\release\final >> "%LOG%"
echo KEEP %LOCALAPPDATA%\Programs\PrivateArchive >> "%LOG%"
echo KEEP %PROJECT%\migrations >> "%LOG%"
echo KEEP %PROJECT%\src >> "%LOG%"
echo KEEP %PROJECT%\.git >> "%LOG%"
echo SUCCESS >> "%LOG%"

echo.
echo 清理完成。
echo 已保留：release\final、正式安装版、源码、migrations、Git 数据。
echo 已清理：release 根目录重复包、dist、测试报告、E2E 临时 D1 状态。
echo 日志：%LOG%
echo.
pause
exit /b 0

:fail
echo FAILED >> "%LOG%"
echo.
echo 清理未完成。安全检查未通过，因此已停止。
echo 请查看日志：%LOG%
echo.
pause
exit /b 1
