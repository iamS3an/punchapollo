param(
    [string]$CdpUrl = "http://localhost:9222",
    [int]$LoginTimeoutMs = 900000
)

# A long-lived WSL session can keep an environment snapshot from before
# Node.js was installed; rebuild PATH from the registry so a fresh install is
# found without restarting WSL.
$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
    [System.Environment]::GetEnvironmentVariable("Path", "User")

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    throw "Windows Node.js was not found. Install the Windows Node.js LTS release first."
}

$env:EDGE_CDP_URL = $CdpUrl
$env:LOGIN_TIMEOUT_MS = "$LoginTimeoutMs"

& $nodeCommand.Source "$PSScriptRoot\src\location-set.js"
exit $LASTEXITCODE
