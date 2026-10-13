param(
    [int]$Port = 9223,
    [int]$LoginTimeoutMs = 180000,
    [string]$ProfileDirectory = "$env:LOCALAPPDATA\punchapollo\edge-profile-test"
)

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    throw "Windows Node.js was not found."
}

$edgeCandidates = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
)

$edgePath = $edgeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edgePath) {
    throw "Microsoft Edge executable was not found."
}

# A throwaway profile opened InPrivate has no cookies and no Windows account
# sign-in, so Microsoft asks for everything.
$arguments = @(
    "--inprivate",
    "--remote-debugging-port=$Port",
    "--user-data-dir=$ProfileDirectory",
    "--no-first-run",
    "--new-window",
    "about:blank"
)

Start-Process -FilePath $edgePath -ArgumentList $arguments

$ready = $false
foreach ($attempt in 1..30) {
    try {
        Invoke-RestMethod "http://localhost:$Port/json/version" -TimeoutSec 2 | Out-Null
        $ready = $true
        break
    } catch {
        Start-Sleep -Seconds 2
    }
}

if ($ready) {
    $env:EDGE_CDP_URL = "http://localhost:$Port"
    $env:LOGIN_TIMEOUT_MS = "$LoginTimeoutMs"
    & $nodeCommand.Source "$PSScriptRoot\src\session-test.js"
    $status = $LASTEXITCODE
} else {
    Write-Host "Edge did not become ready on port $Port."
    $status = 1
}

Start-Sleep -Seconds 4
Remove-Item -Recurse -Force $ProfileDirectory -ErrorAction SilentlyContinue
exit $status
