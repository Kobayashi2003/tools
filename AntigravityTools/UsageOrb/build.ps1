# Builds, tests, and publishes Antigravity UsageOrb to dist/UsageOrb.exe.
$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$appProj = Join-Path $root 'src\UsageOrb\UsageOrb.csproj'
$testProj = Join-Path $root 'tests\UsageOrb.Tests\UsageOrb.Tests.csproj'
$distDir = Join-Path $root 'dist'

Write-Host '==> Running unit & integration tests...' -ForegroundColor Cyan
dotnet test $testProj -c Release
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host '==> Publishing Release executable to dist/...' -ForegroundColor Cyan
if (Test-Path $distDir) {
    Remove-Item $distDir -Recurse -Force
}

dotnet publish $appProj `
    -c Release `
    -r win-x64 `
    --self-contained false `
    -p:PublishSingleFile=true `
    -p:IncludeNativeLibrariesForSelfExtract=true `
    -p:DebugSymbols=false `
    -p:DebugType=None `
    -o $distDir

if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$exe = Join-Path $distDir 'UsageOrb.exe'
$sizeMb = [Math]::Round((Get-Item $exe).Length / 1MB, 2)
Write-Host "`nPublished: $exe ($sizeMb MB)" -ForegroundColor Green
