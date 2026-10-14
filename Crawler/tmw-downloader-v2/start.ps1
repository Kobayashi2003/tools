# Starts the server; .\stop.ps1 stops it from another window. Other arguments go to main.py.
# The server steps up from 18040 by itself when that port is taken.
param([Parameter(ValueFromRemainingArguments)][string[]]$Rest = @())
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$runFile = Join-Path $PSScriptRoot '.running.json'

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) { throw 'uv is not on PATH (https://docs.astral.sh/uv/).' }
if (Test-Path -LiteralPath $runFile) { throw 'Already running. Run .\stop.ps1 first.' }
uv sync --locked
if ($LASTEXITCODE -ne 0) { throw 'Could not install dependencies; check the network or proxy and run this again.' }

$server = Start-Process uv -NoNewWindow -PassThru -ArgumentList (@('run', '--locked', 'python', 'main.py') + $Rest)
@{ ProcessId = $server.Id; StartTicks = $server.StartTime.Ticks } | ConvertTo-Json | Set-Content -LiteralPath $runFile
try {
    while (-not $server.HasExited) { Start-Sleep -Milliseconds 500 }
} finally {
    if (-not $server.HasExited) { taskkill /F /T /PID $server.Id 2>&1 | Out-Null }
    Remove-Item -LiteralPath $runFile -ErrorAction SilentlyContinue
}
