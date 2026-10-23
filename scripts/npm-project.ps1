# Use this project's verified portable Node, without changing machine-wide PATH.
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$NpmArgs)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -LiteralPath (Join-Path $projectRoot '.nvmrc') -Raw).Trim()
$runtime = Join-Path $projectRoot ".runtime/node-v$version-win-x64"
$node = Join-Path $runtime 'node.exe'
$npm = Join-Path $runtime 'node_modules/npm/bin/npm-cli.js'
if (!(Test-Path -LiteralPath $node) -or !(Test-Path -LiteralPath $npm)) {
    throw "Missing project Node $version. See docs/node-runtime.md for setup."
}
$actual = & $node --version
if ($LASTEXITCODE -ne 0 -or $actual -ne "v$version") { throw "Unexpected project Node version: $actual" }
$previousPath = $env:PATH
Push-Location $projectRoot
try {
    $env:PATH = "$runtime;$previousPath"
    & $node $npm @NpmArgs
    $npmExitCode = $LASTEXITCODE
} finally {
    $env:PATH = $previousPath
    Pop-Location
}
exit $npmExitCode
