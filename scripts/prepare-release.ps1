param(
    [switch]$RequireSigned,
    [switch]$SkipBuild,
    [string]$NodePath = 'node',
    [string]$NpmCliPath = ''
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$packagePath = Join-Path $projectRoot 'package.json'
$package = [System.IO.File]::ReadAllText($packagePath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$version = [string]$package.version
$productName = [string]$package.build.productName
$distDir = Join-Path $projectRoot 'dist\win-unpacked'
$releaseDir = Join-Path $projectRoot 'release'
$archiveName = "$productName-$version-x64-portable-unsigned.zip"
$archivePath = Join-Path $releaseDir $archiveName

function Invoke-NpmCommand {
    param([string[]]$Arguments)

    if ($NpmCliPath) {
        & $NodePath $NpmCliPath @Arguments
    } else {
        & npm @Arguments
    }

    if ($LASTEXITCODE -ne 0) {
        throw "npm $($Arguments -join ' ') failed"
    }
}

Push-Location $projectRoot
try {
    if (-not $SkipBuild) {
        Invoke-NpmCommand @('run', 'check')
        Invoke-NpmCommand @('test')
        Invoke-NpmCommand @('run', 'build:dir')
    }

    New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
    Copy-Item -LiteralPath (Join-Path $projectRoot 'LICENSE') -Destination $distDir -Force
    Copy-Item -LiteralPath (Join-Path $projectRoot 'THIRD_PARTY_NOTICES.md') -Destination $distDir -Force
    Copy-Item -LiteralPath (Join-Path $projectRoot 'UNSIGNED_BUILD_NOTICE.txt') -Destination $distDir -Force
    Copy-Item -LiteralPath (Join-Path $projectRoot 'third_party_licenses') -Destination $distDir -Recurse -Force

    $executables = Get-ChildItem -LiteralPath $distDir -Recurse -File -Filter '*.exe'
    $invalidSignatures = @($executables | Where-Object { (Get-AuthenticodeSignature -LiteralPath $_.FullName).Status -ne 'Valid' })
    if ($RequireSigned -and $invalidSignatures.Count -gt 0) {
        throw "Signed release required, but $($invalidSignatures.Count) executable(s) do not have a valid Authenticode signature"
    }

    Compress-Archive -Path (Join-Path $distDir '*') -DestinationPath $archivePath -CompressionLevel Optimal -Force
    $hash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $checksum = "$hash  $archiveName`n"
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText((Join-Path $releaseDir 'SHA256SUMS.txt'), $checksum, $utf8NoBom)

    Write-Output "Release archive: $archivePath"
    Write-Output "SHA-256: $hash"
    if ($invalidSignatures.Count -gt 0) {
        Write-Warning 'This is an unsigned test build. Keep UNSIGNED_BUILD_NOTICE.txt and the release warning.'
    }
} finally {
    Pop-Location
}
