$ErrorActionPreference = 'Stop'
$runFile = Join-Path $PSScriptRoot '.running.json'
if (-not (Test-Path -LiteralPath $runFile)) { Write-Host 'Pawchive v2 is not running (no .running.json).'; return }

$run = Get-Content -LiteralPath $runFile -Raw | ConvertFrom-Json
$proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($run.pid)"
if (-not $proc) {
    Remove-Item -LiteralPath $runFile
    Write-Host 'Pawchive v2 is no longer running.'
    return
}

# A PID can be reused after a crash: only stop the process that started just before the
# server wrote the file, and whose command line is this project's server.
$recorded = [datetime]::SpecifyKind([datetime]::Parse($run.started), 'Utc')
$startedUtc = $proc.CreationDate.ToUniversalTime()
$fresh = $startedUtc -le $recorded.AddSeconds(5) -and $startedUtc -ge $recorded.AddMinutes(-5)
$venv = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '.venv'))
$ours = $proc.CommandLine -match 'main\.py(?:"|\s)+serve' -and (
    $proc.CommandLine.Contains($venv) -or $proc.ExecutablePath -eq $run.exe -or
    ((Get-CimInstance Win32_Process -Filter "ProcessId=$($proc.ParentProcessId)").CommandLine -like "*$venv*")
)
if (-not ($fresh -and $ours)) {
    throw "PID $($run.pid) does not look like this project's server; it has not been stopped. Delete .running.json if the server is gone."
}
Stop-Process -Id $run.pid
Remove-Item -LiteralPath $runFile -ErrorAction SilentlyContinue
Write-Host 'Pawchive v2 stopped. Unfinished jobs resume on the next start.'
