[CmdletBinding()]
param()

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$nodePath = (Get-Command node -ErrorAction Stop).Source

Push-Location $repoRoot
try {
  & $nodePath '--import' 'tsx' '.\scripts\manual-server.ts' 'stop'
  exit $LASTEXITCODE
} finally {
  Pop-Location
}