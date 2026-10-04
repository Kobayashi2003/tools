$ErrorActionPreference = 'Stop'
$taskDataRoot = if ($env:NOVELIA_DATA_DIR) { $env:NOVELIA_DATA_DIR } else { Join-Path $PSScriptRoot 'data' }
$taskPidFile = Join-Path $taskDataRoot 'server.pid'
if (-not (Test-Path -LiteralPath $taskPidFile)) { Write-Host 'No server PID file found.'; return }
$taskServerPid = [int](Get-Content -LiteralPath $taskPidFile -Raw).Trim()
$taskProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$taskServerPid"
if ($taskProcess) {
    $taskPython = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '.venv\Scripts\python.exe'))
    if (-not $taskProcess.CommandLine.Contains($taskPython) -or $taskProcess.CommandLine -notmatch 'main\.py(?:"|\s)+serve') {
        throw 'PID does not identify this project server. It has not been stopped.'
    }
    Stop-Process -Id $taskServerPid
    Write-Host 'Server stopped. Unfinished tasks can be resumed after restart.'
} else { Write-Host 'Server is no longer running.' }
Remove-Item -LiteralPath $taskPidFile
