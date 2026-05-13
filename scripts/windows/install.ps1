[CmdletBinding(SupportsShouldProcess)]
param(
  [ValidatePattern('^[A-Za-z]:$')]
  [string]$Drive = 'D:',

  [ValidateRange(1, 65535)]
  [int]$Port = 3000,

  [ValidateNotNullOrEmpty()]
  [string]$ListenHost = '0.0.0.0',

  [ValidateNotNullOrEmpty()]
  [string]$VlcPath = 'C:\Program Files\VideoLAN\VLC\vlc.exe',

  [ValidateRange(1, 60)]
  [int]$PollSeconds = 5,

  [ValidateNotNullOrEmpty()]
  [string]$TaskName = 'VLC DVD Streamer'
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Ensure-Command {
  param([string]$Name)

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command '$Name' was not found in PATH."
  }
}

function Invoke-Step {
  param(
    [string]$Target,
    [string]$Action,
    [scriptblock]$Operation
  )

  if ($PSCmdlet.ShouldProcess($Target, $Action)) {
    & $Operation
  }
}

function Get-LanUrls {
  param([int]$PortNumber)

  $addresses = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
      $_.IPAddress -notlike '127.*' -and
      $_.IPAddress -notlike '169.254.*' -and
      $_.PrefixOrigin -ne 'WellKnown'
    } |
    Select-Object -ExpandProperty IPAddress -Unique)

  return @($addresses | ForEach-Object { 'http://{0}:{1}' -f $_, $PortNumber })
}

$previewOnly = [bool]$WhatIfPreference
if (-not $previewOnly -and -not (Test-Administrator)) {
  throw 'Run this installer from an elevated PowerShell window so it can create the Windows Firewall rule and the scheduled task.'
}

Ensure-Command -Name 'node'
Ensure-Command -Name 'npm'
Ensure-Command -Name 'powershell.exe'
Ensure-Command -Name 'schtasks.exe'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$backgroundScript = Join-Path $repoRoot 'scripts\windows\background-host.ps1'
$runtimeDir = Join-Path $repoRoot '.runtime'
$logDir = Join-Path $runtimeDir 'logs'
$settingsPath = Join-Path $runtimeDir 'installed-settings.json'
$firewallRuleName = "VLC DVD Streamer ($Port)"
$resolvedVlcPath = if (Test-Path -LiteralPath $VlcPath) {
  (Resolve-Path -LiteralPath $VlcPath).Path
} else {
  throw "VLC was not found at '$VlcPath'. Install VLC 3.x or pass -VlcPath with the correct location."
}

Invoke-Step -Target $runtimeDir -Action 'create runtime directories' -Operation {
  New-Item -ItemType Directory -Force -Path $runtimeDir, $logDir | Out-Null
}

Invoke-Step -Target $repoRoot -Action 'install dependencies if needed' -Operation {
  Push-Location $repoRoot
  try {
    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'node_modules'))) {
      & npm ci
    }
  } finally {
    Pop-Location
  }
}

Invoke-Step -Target $repoRoot -Action 'build the production server' -Operation {
  Push-Location $repoRoot
  try {
    & npm run build
  } finally {
    Pop-Location
  }
}

$settings = [ordered]@{
  repoRoot = $repoRoot
  drive = $Drive.ToUpperInvariant()
  host = $ListenHost
  port = $Port
  vlcPath = $resolvedVlcPath
  pollSeconds = $PollSeconds
  taskName = $TaskName
}

Invoke-Step -Target $settingsPath -Action 'write installed settings' -Operation {
  $settings | ConvertTo-Json | Set-Content -LiteralPath $settingsPath
}

Invoke-Step -Target $firewallRuleName -Action 'create or replace the private LAN firewall rule' -Operation {
  $existingRule = Get-NetFirewallRule -DisplayName $firewallRuleName -ErrorAction SilentlyContinue
  if ($existingRule) {
    Remove-NetFirewallRule -DisplayName $firewallRuleName
  }

  New-NetFirewallRule -DisplayName $firewallRuleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Domain,Private | Out-Null
}

$taskCommand = @(
  'powershell.exe'
  '-NoLogo'
  '-NoProfile'
  '-ExecutionPolicy'
  'Bypass'
  '-WindowStyle'
  'Hidden'
  '-File'
  ('"{0}"' -f $backgroundScript)
  '-SettingsPath'
  ('"{0}"' -f $settingsPath)
) -join ' '

Invoke-Step -Target $TaskName -Action 'register the background host task' -Operation {
  & schtasks.exe /Create /TN $TaskName /SC ONLOGON /TR $taskCommand /F | Out-Null
}

Invoke-Step -Target $TaskName -Action 'start the background host task now' -Operation {
  & schtasks.exe /Run /TN $TaskName | Out-Null
}

$lanUrls = Get-LanUrls -PortNumber $Port

Write-Host ''
Write-Host 'Windows install complete.'
Write-Host "Drive watch: $($settings.drive)"
Write-Host "Local service URL: http://127.0.0.1:$Port"
if ($lanUrls.Count -gt 0) {
  Write-Host 'LAN URLs:'
  foreach ($url in $lanUrls) {
    Write-Host "  $url"
  }
} else {
  Write-Host 'No LAN IPv4 address was detected. The firewall rule is in place, but Windows may still be on a public profile or disconnected from the network.'
}
Write-Host ''
Write-Host 'The installer created:'
Write-Host '  - a scheduled task that starts the background host at logon'
Write-Host '  - a Windows Firewall inbound rule for the selected TCP port on Domain and Private networks'
Write-Host '  - .runtime\installed-settings.json with the chosen drive, port, and VLC path'
Write-Host ''
Write-Host 'Insert a DVD, wait a few seconds, then open one of the LAN URLs from another machine on your network.'
Write-Host 'If your Windows network is marked Public, change it to Private or update the firewall rule manually.'