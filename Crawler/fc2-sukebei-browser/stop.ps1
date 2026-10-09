$ErrorActionPreference = 'Stop'
# Same lookup as app/config.py: the environment, then the first FC2SB_DATA_DIR in .env, then .\data;
# a relative path is relative to this folder.
$taskDataSetting = $env:FC2SB_DATA_DIR
$taskEnvFile = Join-Path $PSScriptRoot '.env'
if (-not $taskDataSetting -and (Test-Path -LiteralPath $taskEnvFile)) {
    $taskLine = Get-Content -LiteralPath $taskEnvFile | Where-Object { $_ -match '^\s*FC2SB_DATA_DIR\s*=' } | Select-Object -First 1
    if ($taskLine) { $taskDataSetting = ($taskLine -split '=', 2)[1].Trim().Trim('"').Trim("'") }
}
$taskDataRoot = if (-not $taskDataSetting) { Join-Path $PSScriptRoot 'data' }
    elseif ([System.IO.Path]::IsPathRooted($taskDataSetting)) { $taskDataSetting }
    else { Join-Path $PSScriptRoot $taskDataSetting }
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
    Write-Host 'Server stopped. Titles still waiting for metadata resume on the next start.'
} else { Write-Host 'Server is no longer running.' }
Remove-Item -LiteralPath $taskPidFile
