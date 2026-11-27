# Builds, tests, and publishes Antigravity UsageOrb to dist/UsageOrb.exe.
$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$appProj = Join-Path $root 'src\UsageOrb\UsageOrb.csproj'
$testProj = Join-Path $root 'tests\UsageOrb.Tests\UsageOrb.Tests.csproj'
$distDir = Join-Path $root 'dist'
$exe = Join-Path $distDir 'UsageOrb.exe'
$stagingRoot = Join-Path $root 'src\UsageOrb\obj\bundle-staging'
$buildId = [Guid]::NewGuid().ToString('N')
$stagingDir = Join-Path $stagingRoot $buildId

Write-Host '==> Running unit & integration tests...' -ForegroundColor Cyan
dotnet test $testProj -c Release
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host '==> Publishing self-contained Windows x64 executable to dist/...' -ForegroundColor Cyan

try {
    dotnet publish $appProj `
        -c Release `
        -r win-x64 `
        --self-contained true `
        -p:PublishSingleFile=true `
        -p:IncludeNativeLibrariesForSelfExtract=true `
        -p:DebugSymbols=false `
        -p:DebugType=None `
        -o $stagingDir

    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    $null = New-Item -Path $distDir -ItemType Directory -Force
    $stagedExe = Join-Path $stagingDir 'UsageOrb.exe'
    if ([IO.File]::Exists($exe)) {
        # Keep the previous image outside dist while a running instance still has it open.
        $previousExe = Join-Path $stagingRoot "UsageOrb.previous-$buildId.exe"
        [IO.File]::Replace($stagedExe, $exe, $previousExe)
    }
    else {
        [IO.File]::Move($stagedExe, $exe)
    }
}
finally {
    if (Test-Path -LiteralPath $stagingDir -PathType Container) {
        $resolvedStagingDir = (Resolve-Path -LiteralPath $stagingDir).ProviderPath
        if ((Split-Path -Parent $resolvedStagingDir) -eq $stagingRoot) {
            Remove-Item -LiteralPath $resolvedStagingDir -Recurse -Force
        }
    }

    Get-ChildItem -LiteralPath $stagingRoot -Filter 'UsageOrb.previous-*.exe' -File -ErrorAction SilentlyContinue |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
}

$sizeMb = [Math]::Round((Get-Item $exe).Length / 1MB, 2)
Write-Host "`nPublished: $exe ($sizeMb MB)" -ForegroundColor Green
