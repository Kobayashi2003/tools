# Opens the interactive shell in this window; .\stop.ps1 ends it from another one.
# Runs in the foreground: Ctrl+C interrupts the current command, not the shell.
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) { throw 'uv is not on PATH (https://docs.astral.sh/uv/).' }
$python = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '.venv\Scripts\python.exe'))
if (Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.ExecutablePath -eq $python }) {
    throw 'pawchive is already running; two shells would share one queue. Use that window, or run .\stop.ps1.'
}
uv sync --locked
if ($LASTEXITCODE -ne 0) { throw 'Could not install dependencies; check the network or proxy and run this again.' }
uv run --locked python main.py
