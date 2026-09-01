$ErrorActionPreference = 'Stop'

$line = Get-Content '.dev.vars' | Where-Object { $_ -like 'TEMP_OWNER_LOGIN_PASSWORD=*' }
if (-not $line) { throw 'TEMP_OWNER_LOGIN_PASSWORD is missing from .dev.vars' }
$password = $line.Substring($line.IndexOf('=') + 1)
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$headers = @{ Origin = 'https://photo.joye.cc.cd' }
$body = @{ password = $password } | ConvertTo-Json -Compress

$login = Invoke-WebRequest -Uri 'https://photo.joye.cc.cd/api/auth/login' -Method POST -Headers $headers -Body $body -ContentType 'application/json' -WebSession $session -UseBasicParsing
Write-Output ("login={0}" -f [int]$login.StatusCode)

$settings = Invoke-WebRequest -Uri 'https://photo.joye.cc.cd/api/settings/status' -WebSession $session -UseBasicParsing
Write-Output ("settings={0}" -f [int]$settings.StatusCode)

$configure = Invoke-WebRequest -Uri 'https://photo.joye.cc.cd/api/telegram/webhook/configure' -Method POST -Headers $headers -Body '{}' -ContentType 'application/json' -WebSession $session -UseBasicParsing
Write-Output ("webhook-configure={0} {1}" -f [int]$configure.StatusCode, $configure.Content)

$status = Invoke-WebRequest -Uri 'https://photo.joye.cc.cd/api/telegram/webhook/status' -WebSession $session -UseBasicParsing
Write-Output ("webhook-status={0} {1}" -f [int]$status.StatusCode, $status.Content)
