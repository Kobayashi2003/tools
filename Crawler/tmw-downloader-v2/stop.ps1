# Stops what .\start.ps1 started, from any window.
$ErrorActionPreference = 'Stop'
$runFile = Join-Path $PSScriptRoot '.running.json'
if (-not (Test-Path -LiteralPath $runFile)) { Write-Host 'Not running.'; return }
foreach ($entry in @(Get-Content -LiteralPath $runFile -Raw | ConvertFrom-Json)) {
    $process = Get-Process -Id $entry.ProcessId -ErrorAction SilentlyContinue
    # A PID is reused once its process exits; the start time says it is still the one started here.
    if ($process -and $process.StartTime.Ticks -eq $entry.StartTicks) {
        taskkill /F /T /PID $entry.ProcessId 2>&1 | Out-Null
        Write-Host "Stopped $($process.Name) (PID $($entry.ProcessId))."
    }
}
Remove-Item -LiteralPath $runFile -ErrorAction SilentlyContinue
