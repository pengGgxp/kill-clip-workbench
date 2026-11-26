[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$desktopRoot = Join-Path $root 'apps\desktop'
$electron = Join-Path $desktopRoot 'node_modules\electron\dist\electron.exe'
$viteHost = '127.0.0.1'
$vitePort = 5666
$viteUrl = "http://$viteHost`:$vitePort/"

function Test-PortOpen {
  param(
    [string]$HostName,
    [int]$Port,
    [int]$TimeoutMilliseconds = 250
  )

  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $task = $client.ConnectAsync($HostName, $Port)
    return $task.Wait($TimeoutMilliseconds) -and $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Test-WorkbenchUrl {
  try {
    $response = Invoke-WebRequest `
      -Uri "${viteUrl}workbench" `
      -UseBasicParsing `
      -TimeoutSec 2
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

if (!(Test-Path -LiteralPath $electron)) {
  throw "Electron was not found at $electron. Run pnpm install in the repository root first."
}

$pnpm = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
if (!$pnpm) {
  throw 'pnpm.cmd was not found. Install pnpm or run this script from a shell that has pnpm configured.'
}

Set-Location -LiteralPath $root

if (!(Test-WorkbenchUrl)) {
  if (Test-PortOpen -HostName $viteHost -Port $vitePort) {
    throw "Port $vitePort is already used by another process, so the workbench Vite server cannot start."
  }

  $vite = Start-Process `
    -FilePath $pnpm.Source `
    -ArgumentList @(
      '-F',
      '@vben/web-antd',
      'exec',
      'vite',
      '--host',
      $viteHost,
      '--port',
      $vitePort,
      '--strictPort'
    ) `
    -WorkingDirectory $root `
    -WindowStyle Hidden `
    -PassThru

  $ready = $false
  for ($attempt = 0; $attempt -lt 120; $attempt++) {
    if ($vite.HasExited) {
      throw "Vite exited with code $($vite.ExitCode). Check workbench-vite-error.log."
    }
    if (Test-WorkbenchUrl) {
      $ready = $true
      break
    }
    Start-Sleep -Milliseconds 250
  }

  if (!$ready) {
    throw "Timed out waiting for the Vite server at $viteUrl"
  }
}

$env:KILL_CLIP_DEV_URL = $viteUrl
$logId = [guid]::NewGuid().ToString('N')
$stdoutLog = Join-Path $env:TEMP "kill-clip-workbench-$logId.stdout.log"
$stderrLog = Join-Path $env:TEMP "kill-clip-workbench-$logId.stderr.log"
$electronProcess = Start-Process `
  -FilePath $electron `
  -ArgumentList @('.', '--enable-logging') `
  -WorkingDirectory $desktopRoot `
  -RedirectStandardOutput $stdoutLog `
  -RedirectStandardError $stderrLog `
  -PassThru

$windowProcess = $null
$deadline = [DateTime]::UtcNow.AddSeconds(60)
while ([DateTime]::UtcNow -lt $deadline) {
  $windowProcess = Get-Process -Name electron -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Path -eq $electron -and $_.MainWindowTitle -eq '击杀点剪辑工作台'
    } |
    Select-Object -First 1
  if ($windowProcess) {
    break
  }

  $electronProcess.Refresh()
  if ($electronProcess.HasExited) {
    break
  }
  Start-Sleep -Milliseconds 250
}

if (!$windowProcess) {
  $diagnostics = @()
  foreach ($log in @($stdoutLog, $stderrLog)) {
    if (Test-Path -LiteralPath $log) {
      $diagnostics += Get-Content -Tail 40 -LiteralPath $log
    }
  }
  if ($diagnostics.Count -gt 0) {
    Write-Host ($diagnostics -join [Environment]::NewLine)
  }
  throw "The desktop workbench window did not open within 60 seconds. Electron logs: $stdoutLog and $stderrLog"
}

Write-Host "Development desktop workbench opened (PID $($windowProcess.Id))."
