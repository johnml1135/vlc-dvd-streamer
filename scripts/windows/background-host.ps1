[CmdletBinding()]
param(
  [string]$SettingsPath = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path '.runtime\installed-settings.json')
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$mutex = New-Object System.Threading.Mutex($false, 'Global\VlcDvdStreamerBackgroundHost')
if (-not $mutex.WaitOne(0, $false)) {
  return
}

try {
  function Get-Settings {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
      throw "Installed settings were not found at '$Path'. Run scripts/windows/install.ps1 first."
    }

    return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  }

  function Write-Log {
    param([string]$Message)

    $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -LiteralPath $script:backgroundLogPath -Value "$timestamp $Message"
  }

  function Test-ServerResponsive {
    try {
      Invoke-RestMethod -Method Get -Uri $script:healthUrl -TimeoutSec 5 | Out-Null
      return $true
    } catch {
      return $false
    }
  }

  function Wait-ServerResponsive {
    param([int]$TimeoutSeconds = 60)

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
      if (Test-ServerResponsive) {
        return
      }

      Start-Sleep -Seconds 2
    }

    throw "The local server did not respond on $($script:healthUrl) within $TimeoutSeconds seconds."
  }

  function Start-ServerProcess {
    if ($script:serverProcess -and -not $script:serverProcess.HasExited) {
      return
    }

    Set-Item -Path 'Env:HOST' -Value ([string]$script:settings.host)
    Set-Item -Path 'Env:PORT' -Value ([string]$script:settings.port)
    Set-Item -Path 'Env:CACHE_DIR' -Value $script:cacheDir
    Set-Item -Path 'Env:DVD_DRIVE' -Value ([string]$script:settings.drive)
    Set-Item -Path 'Env:VLC_PATH' -Value ([string]$script:settings.vlcPath)

    $script:serverProcess = Start-Process -FilePath $script:nodePath -ArgumentList @('dist/server.js') -WorkingDirectory $script:settings.repoRoot -PassThru -RedirectStandardOutput $script:serverStdOutPath -RedirectStandardError $script:serverStdErrPath

    Write-Log "Started server process PID $($script:serverProcess.Id)."
    Wait-ServerResponsive
  }

  function Ensure-Server {
    if (Test-ServerResponsive) {
      return
    }

    if ($script:serverProcess -and $script:serverProcess.HasExited) {
      Write-Log "Server process PID $($script:serverProcess.Id) exited with code $($script:serverProcess.ExitCode). Restarting."
      $script:serverProcess = $null
    }

    Start-ServerProcess
  }

  function Invoke-CatalogRefresh {
    try {
      $response = Invoke-RestMethod -Method Post -Uri $script:refreshUrl -TimeoutSec 90
      $state = if ($response.state) { $response.state } else { 'unknown' }
      Write-Log "Catalog refresh completed with state '$state'."
    } catch {
      Write-Log "Catalog refresh failed: $($_.Exception.Message)"
    }
  }

  function Get-DiscSignature {
    param([string]$Drive)

    $root = if ($Drive.EndsWith('\')) { $Drive } else { "$Drive\" }

    try {
      $driveInfo = New-Object System.IO.DriveInfo($root)
    } catch {
      return 'missing-drive'
    }

    try {
      if (-not $driveInfo.IsReady) {
        return 'empty'
      }

      $videoTsPath = Join-Path $root 'VIDEO_TS'
      $ifoNames = @()
      if (Test-Path -LiteralPath $videoTsPath) {
        $ifoNames = @(Get-ChildItem -LiteralPath $videoTsPath -Filter '*.IFO' -File -ErrorAction SilentlyContinue |
          Sort-Object Name |
          Select-Object -ExpandProperty Name)
      }

      return ('ready:{0}:{1}' -f $driveInfo.VolumeLabel, ($ifoNames -join ','))
    } catch {
      return "error:$($_.Exception.Message)"
    }
  }

  $settings = Get-Settings -Path $SettingsPath
  $nodePath = (Get-Command node -ErrorAction Stop).Source

  $logDir = Join-Path $settings.repoRoot '.runtime\logs'
  $cacheDir = Join-Path $settings.repoRoot '.cache'
  New-Item -ItemType Directory -Force -Path $logDir, $cacheDir | Out-Null

  $script:settings = $settings
  $script:nodePath = $nodePath
  $script:cacheDir = $cacheDir
  $script:backgroundLogPath = Join-Path $logDir 'background-host.log'
  $script:serverStdOutPath = Join-Path $logDir 'server.stdout.log'
  $script:serverStdErrPath = Join-Path $logDir 'server.stderr.log'
  $script:discStatePath = Join-Path $settings.repoRoot '.runtime\disc-state.txt'
  $script:healthUrl = "http://127.0.0.1:$($settings.port)/api/health"
  $script:refreshUrl = "http://127.0.0.1:$($settings.port)/api/discs/current/refresh"
  $script:serverProcess = $null

  Write-Log "Background host starting for drive $($settings.drive) on port $($settings.port)."

  $lastSignature = if (Test-Path -LiteralPath $script:discStatePath) {
    Get-Content -LiteralPath $script:discStatePath -Raw
  } else {
    ''
  }

  while ($true) {
    Ensure-Server

    $currentSignature = Get-DiscSignature -Drive $settings.drive
    if ($currentSignature -ne $lastSignature) {
      Write-Log "Detected disc state change: '$lastSignature' -> '$currentSignature'."
      Set-Content -LiteralPath $script:discStatePath -Value $currentSignature
      Invoke-CatalogRefresh
      $lastSignature = $currentSignature
    }

    Start-Sleep -Seconds ([int]$settings.pollSeconds)
  }
} finally {
  if ($mutex) {
    $mutex.ReleaseMutex()
    $mutex.Dispose()
  }
}