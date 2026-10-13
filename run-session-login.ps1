param(
    [string]$CdpUrl = "http://localhost:9222",
    [int]$LoginTimeoutMs = 900000
)

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    throw "Windows Node.js was not found. Install the Windows Node.js LTS release first."
}

$env:EDGE_CDP_URL = $CdpUrl
$env:LOGIN_TIMEOUT_MS = "$LoginTimeoutMs"

& $nodeCommand.Source "$PSScriptRoot\src\session-login.js"
exit $LASTEXITCODE
