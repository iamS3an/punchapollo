param(
    [int]$Port = 9222,
    [string]$ProfileDirectory = "$env:LOCALAPPDATA\punchapollo\edge-profile",
    [Parameter(Mandatory = $true)]
    [string]$Url
)

$edgeCandidates = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
)

$edgePath = $edgeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edgePath) {
    throw "Microsoft Edge executable was not found."
}

$arguments = @(
    "--remote-debugging-port=$Port",
    "--user-data-dir=$ProfileDirectory",
    "--new-window",
    $Url
)

Start-Process -FilePath $edgePath -ArgumentList $arguments
Write-Host "Edge started with persistent profile: $ProfileDirectory"
Write-Host "DevTools endpoint: http://localhost:$Port"
