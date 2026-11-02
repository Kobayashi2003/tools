# Starts the server and opens it in the browser (-NoBrowser to skip); .\stop.ps1 stops it
# from another window. Needs uv; the first run sets up .venv.
param([int]$Port = 18060, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    throw "Port $Port is already in use. If Pawchive v2 is running, open http://127.0.0.1:$Port/ or run .\stop.ps1 first."
}

$venvPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) { throw 'uv is not on PATH (https://docs.astral.sh/uv/).' }
uv sync --locked
if ($LASTEXITCODE -ne 0) { throw 'Installing dependencies failed; check the network or proxy and run this again.' }

Write-Host "Pawchive v2 on http://127.0.0.1:$Port/  (Ctrl+C or .\stop.ps1 to stop)"
# The server records its own PID and start time in .running.json for stop.ps1.
if (-not $NoBrowser) {
    # Open the page once it answers; the job ends with this script.
    $null = Start-ThreadJob -ArgumentList "http://127.0.0.1:$Port/" -ScriptBlock {
        param($url)
        for ($i = 0; $i -lt 240; $i++) {
            try { $null = Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 2; Start-Process $url; return }
            catch { if ($_.Exception.Response) { Start-Process $url; return } }
            Start-Sleep -Milliseconds 500
        }
    }
}
& $venvPython main.py serve --port $Port
