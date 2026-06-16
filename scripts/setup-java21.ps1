$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $projectRoot '.firebase\runtime'
$target = Join-Path $runtimeRoot 'java-21'
$javaExecutable = Join-Path $target 'bin\java.exe'

if (Test-Path -LiteralPath $javaExecutable) {
  & $javaExecutable -version
  exit 0
}

$assetUrl = 'https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=x64&image_type=jre&os=windows&vendor=eclipse'
$asset = (Invoke-RestMethod -Uri $assetUrl -Headers @{ 'User-Agent' = 'Pavia-Firebase-Setup' })[0]
$package = $asset.binary.package

if (-not $package.link -or -not $package.checksum) {
  throw 'The Adoptium API did not return a Java runtime package and checksum.'
}

New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
$download = Join-Path $runtimeRoot 'temurin-21.zip'
$extract = Join-Path $runtimeRoot 'temurin-21-extract'

Write-Host "Downloading Eclipse Temurin $($asset.version.semver)..."
& curl.exe --location --fail --retry 3 --output $download $package.link
if ($LASTEXITCODE -ne 0) {
  throw "Eclipse Temurin download failed with exit code $LASTEXITCODE."
}

$actualChecksum = (Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash.ToLowerInvariant()
$expectedChecksum = ([string]$package.checksum).ToLowerInvariant()
if ($actualChecksum -ne $expectedChecksum) {
  Remove-Item -LiteralPath $download -Force
  throw 'The downloaded Java runtime checksum did not match the Adoptium release metadata.'
}

if (Test-Path -LiteralPath $extract) {
  $resolvedExtract = (Resolve-Path -LiteralPath $extract).Path
  $resolvedRuntime = (Resolve-Path -LiteralPath $runtimeRoot).Path
  if (-not $resolvedExtract.StartsWith($resolvedRuntime, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove an extraction directory outside $resolvedRuntime."
  }
  Remove-Item -LiteralPath $resolvedExtract -Recurse -Force
}

Expand-Archive -LiteralPath $download -DestinationPath $extract
$javaDirectory = Get-ChildItem -LiteralPath $extract -Directory | Select-Object -First 1
if (-not $javaDirectory) {
  throw 'The downloaded Java archive did not contain an installation directory.'
}

if (Test-Path -LiteralPath $target) {
  $resolvedTarget = (Resolve-Path -LiteralPath $target).Path
  $resolvedRuntime = (Resolve-Path -LiteralPath $runtimeRoot).Path
  if (-not $resolvedTarget.StartsWith($resolvedRuntime, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to replace a Java directory outside $resolvedRuntime."
  }
  Remove-Item -LiteralPath $resolvedTarget -Recurse -Force
}

Move-Item -LiteralPath $javaDirectory.FullName -Destination $target
Remove-Item -LiteralPath $extract -Recurse -Force
Remove-Item -LiteralPath $download -Force

& $javaExecutable -version
