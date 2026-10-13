$ErrorActionPreference = 'Stop'
$taskNode = (Get-Command node -ErrorAction Stop).Source
$taskAddress = 'http://127.0.0.1:8765/'
$taskAlreadyRunning = $false
try {
  $taskResponse = Invoke-WebRequest -Uri $taskAddress -UseBasicParsing -TimeoutSec 2
  $taskAlreadyRunning = $taskResponse.Content.Contains('<title>Tune Workshop</title>')
} catch {}
if (-not $taskAlreadyRunning) {
  Start-Process -FilePath $taskNode -ArgumentList ('"' + (Join-Path $PSScriptRoot 'server.mjs') + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
  for ($taskAttempt = 0; $taskAttempt -lt 30; $taskAttempt++) {
    Start-Sleep -Milliseconds 200
    try {
      $taskResponse = Invoke-WebRequest -Uri $taskAddress -UseBasicParsing -TimeoutSec 2
      if ($taskResponse.Content.Contains('<title>Tune Workshop</title>')) { $taskAlreadyRunning = $true; break }
    } catch {}
  }
}
if (-not $taskAlreadyRunning) { throw 'Tune Workshop did not start. Port 8765 may already be in use.' }
Start-Process $taskAddress
