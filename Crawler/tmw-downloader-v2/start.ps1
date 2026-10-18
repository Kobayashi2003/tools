# Starts the server and opens it in the browser (-NoBrowser to skip); .\stop.ps1 stops it from
# another window. Other arguments go to main.py.
# The server steps up from 18040 by itself when that port is taken.
param(
    [switch]$NoBrowser,
    [Parameter(ValueFromRemainingArguments)][string[]]$Rest = @()
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$runFile = Join-Path $PSScriptRoot '.running.json'

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) { throw 'uv is not on PATH (https://docs.astral.sh/uv/).' }
if (Test-Path -LiteralPath $runFile) {
    # A launcher killed from outside leaves its file behind; only a live process counts.
    $entry = Get-Content -LiteralPath $runFile -Raw | ConvertFrom-Json
    $process = Get-Process -Id $entry.ProcessId -ErrorAction SilentlyContinue
    if ($process -and $process.StartTime.Ticks -eq $entry.StartTicks) { throw 'Already running. Run .\stop.ps1 first.' }
}
uv sync --locked
if ($LASTEXITCODE -ne 0) { throw 'Could not install dependencies; check the network or proxy and run this again.' }

# main.py opens the browser itself on whichever port it lands.
$serverArgs = @('run', '--locked', 'python', 'main.py') + $Rest
if ($NoBrowser) { $serverArgs += '--no-open' }
$server = Start-Process uv -NoNewWindow -PassThru -ArgumentList $serverArgs
@{ ProcessId = $server.Id; StartTicks = $server.StartTime.Ticks } | ConvertTo-Json | Set-Content -LiteralPath $runFile
try {
    while (-not $server.HasExited) { Start-Sleep -Milliseconds 500 }
} finally {
    if (-not $server.HasExited) { taskkill /F /T /PID $server.Id 2>&1 | Out-Null }
    Remove-Item -LiteralPath $runFile -ErrorAction SilentlyContinue
}
