$ErrorActionPreference = 'Stop'

$firebaseRunner = Join-Path $PSScriptRoot 'run-firebase.ps1'

& $firebaseRunner `
  'emulators:exec' `
  '--only' `
  'auth,database' `
  '--project' `
  'demo-pavia-local' `
  'node scripts/firebase-emulator-smoke.mjs'

exit $LASTEXITCODE
