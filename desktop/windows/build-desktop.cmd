@echo off
setlocal EnableExtensions

for %%I in ("%~dp0..\..") do set "ROOT=%%~fI"
set "OUT=%ROOT%\release\final"
set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo [ERROR] .NET Framework C# compiler not found.
  exit /b 1
)
if not exist "%OUT%" mkdir "%OUT%"
if exist "%ROOT%\release\README.txt" copy /Y "%ROOT%\release\README.txt" "%OUT%\README.txt" >nul
if not exist "%ROOT%\dist\index.html" (
  echo [ERROR] Missing dist build. Run npm run build first.
  exit /b 1
)

echo [1/8] Building Telegram User Storage Bridge...
call "%ROOT%\desktop\telegram_bridge\build-bridge.cmd" || exit /b 1

echo [2/8] Packaging embedded desktop web bundle...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$src='%ROOT%\dist\*'; $zip='%OUT%\PrivateArchive-Web.zip'; if(Test-Path $zip){Remove-Item -Force $zip}; Compress-Archive -Path $src -DestinationPath $zip -CompressionLevel Optimal" || exit /b 1

echo [3/8] Building desktop SaaS launcher...
"%CSC%" /nologo /target:winexe /platform:x64 /optimize+ /reference:System.Management.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll /reference:System.Web.Extensions.dll /resource:"%OUT%\PrivateArchive-Web.zip",PrivateArchive.Web /resource:"%OUT%\TelegramStorageBridge.exe",PrivateArchive.TelegramBridge /out:"%OUT%\PrivateArchive.exe" "%ROOT%\desktop\windows\DesktopLauncher.cs" || exit /b 1

echo [4/8] Building local launcher...
"%CSC%" /nologo /target:winexe /platform:x64 /optimize+ /define:LOCAL /reference:System.Management.dll /out:"%OUT%\PrivateArchive-Local.exe" "%ROOT%\desktop\windows\Launcher.cs" || exit /b 1

echo [5/8] Building uninstaller...
"%CSC%" /nologo /target:winexe /platform:x64 /optimize+ /reference:System.Windows.Forms.dll /out:"%OUT%\PrivateArchive-Uninstall.exe" "%ROOT%\desktop\windows\Uninstaller.cs" || exit /b 1

echo [6/8] Building setup installer...
"%CSC%" /nologo /target:winexe /platform:x64 /optimize+ /reference:System.Windows.Forms.dll /resource:"%OUT%\PrivateArchive.exe",PrivateArchive.App /resource:"%OUT%\PrivateArchive-Uninstall.exe",PrivateArchive.Uninstall /out:"%OUT%\PrivateArchive-Setup.exe" "%ROOT%\desktop\windows\Installer.cs" || exit /b 1

echo [7/8] Checksums and ZIP...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$out='%OUT%'; $ascii=[Text.Encoding]::ASCII; $formal=@('PrivateArchive.exe','PrivateArchive-Setup.exe','PrivateArchive-Uninstall.exe'); $lines=$formal | ForEach-Object { $h=(Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $out $_)).Hash.ToLowerInvariant(); $h+'  '+$_ }; [IO.File]::WriteAllText((Join-Path $out 'SHA256SUMS.txt'),(($lines -join [char]10)+[char]10),$ascii); $lh=(Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $out 'PrivateArchive-Local.exe')).Hash.ToLowerInvariant(); [IO.File]::WriteAllText((Join-Path $out 'LOCAL-SHA256.txt'),($lh+'  PrivateArchive-Local.exe'+[char]10),$ascii); Compress-Archive -Force -Path (Join-Path $out 'PrivateArchive.exe'),(Join-Path $out 'PrivateArchive-Setup.exe'),(Join-Path $out 'PrivateArchive-Uninstall.exe'),(Join-Path $out 'README.txt'),(Join-Path $out 'SHA256SUMS.txt') -DestinationPath (Join-Path $out 'PrivateArchive-Windows-v0.1.0.zip'); $zh=(Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $out 'PrivateArchive-Windows-v0.1.0.zip')).Hash.ToLowerInvariant(); [IO.File]::WriteAllText((Join-Path $out 'ZIP-SHA256.txt'),($zh+'  PrivateArchive-Windows-v0.1.0.zip'+[char]10),$ascii)" || exit /b 1

echo [8/8] Syncing canonical release artifacts...
for %%F in (PrivateArchive.exe PrivateArchive-Local.exe PrivateArchive-Setup.exe PrivateArchive-Uninstall.exe PrivateArchive-Windows-v0.1.0.zip README.txt SHA256SUMS.txt LOCAL-SHA256.txt ZIP-SHA256.txt) do copy /Y "%OUT%\%%F" "%ROOT%\release\%%F" >nul || exit /b 1

echo.
echo [OK] Windows distribution ready:
echo %OUT%
exit /b 0
