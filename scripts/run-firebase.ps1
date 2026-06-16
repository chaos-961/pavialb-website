param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$FirebaseArguments
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$localJavaHome = Join-Path $projectRoot '.firebase\runtime\java-21'
$firebaseCommand = Join-Path $projectRoot 'node_modules\.bin\firebase.cmd'

function Get-JavaMajorVersion {
  param([string]$JavaExecutable)

  if (-not (Test-Path -LiteralPath $JavaExecutable)) {
    return 0
  }

  $previousErrorPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $versionOutput = (& $JavaExecutable -version 2>&1 | Out-String)
  $ErrorActionPreference = $previousErrorPreference
  if ($versionOutput -match 'version "(\d+)') {
    return [int]$Matches[1]
  }

  return 0
}

$javaHomes = @()
if ($env:JAVA_HOME) {
  $javaHomes += $env:JAVA_HOME
}
$javaHomes += $localJavaHome

$pathJava = Get-Command java -ErrorAction SilentlyContinue
if ($pathJava) {
  $javaHomes += Split-Path -Parent (Split-Path -Parent $pathJava.Source)
}

$javaHome = $javaHomes |
  Select-Object -Unique |
  Where-Object {
    (Get-JavaMajorVersion (Join-Path $_ 'bin\java.exe')) -ge 21
  } |
  Select-Object -First 1

if (-not $javaHome) {
  throw 'Firebase Tools requires Java 21 or newer. Run "npm run setup:java" first.'
}

if (-not (Test-Path -LiteralPath $firebaseCommand)) {
  throw 'Firebase Tools is not installed. Run "npm install" first.'
}

$env:JAVA_HOME = $javaHome
$env:PATH = "$(Join-Path $javaHome 'bin');$env:PATH"

& $firebaseCommand @FirebaseArguments
exit $LASTEXITCODE
