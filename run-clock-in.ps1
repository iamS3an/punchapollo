param(
    [string]$CdpUrl = "http://localhost:9222",
    [int]$LoginTimeoutMs = 600000,
    [int]$PageLoadTimeoutMs = 90000,
    [int]$SubmitTimeoutMs = 60000,
    [switch]$Scheduled,
    [string]$PlanDate = "",
    [ValidateSet("clock-in", "clock-out", "plan")]
    [Parameter(Mandatory = $true)]
    [string]$Action
)

# A long-lived WSL session can keep an environment snapshot from before
# Node.js was installed; rebuild PATH from the registry so a fresh install is
# found without restarting WSL.
$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
    [System.Environment]::GetEnvironmentVariable("Path", "User")

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    throw "Windows Node.js was not found."
}

$env:EDGE_CDP_URL = $CdpUrl
$env:LOGIN_TIMEOUT_MS = "$LoginTimeoutMs"
$env:PAGE_LOAD_TIMEOUT_MS = "$PageLoadTimeoutMs"
$env:SUBMIT_TIMEOUT_MS = "$SubmitTimeoutMs"
$env:PUNCH_SCHEDULED = if ($Scheduled) { "1" } else { "0" }
$env:PUNCH_PLAN_DATE = $PlanDate
$env:PUNCH_ACTION = $Action

& $nodeCommand.Source "$PSScriptRoot\src\clock-in.js"
exit $LASTEXITCODE
