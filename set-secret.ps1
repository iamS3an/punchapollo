param(
    [ValidateSet("totp", "password")]
    [Parameter(Mandatory = $true)]
    [string]$Kind
)

# A long-lived terminal (or WSL session) can keep an environment snapshot from
# before Node.js was installed; rebuild PATH from the registry so a fresh
# install is found without restarting it.
$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
    [System.Environment]::GetEnvironmentVariable("Path", "User")

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    throw "Windows Node.js was not found."
}

if ($Kind -eq "totp") {
    $name = "totp-secret"
    $prompt = "TOTP secret (base32 key or otpauth:// URI; input is hidden)"
} else {
    $name = "sso-password"
    $prompt = "Microsoft account password (input is hidden)"
}

$directory = Join-Path $env:LOCALAPPDATA "punchapollo"
$path = Join-Path $directory "$name.dpapi"

$secure = Read-Host -AsSecureString $prompt
if ($secure.Length -eq 0) {
    throw "Nothing was entered."
}

New-Item -ItemType Directory -Force -Path $directory | Out-Null
$secure | ConvertFrom-SecureString | Set-Content -Path $path -Encoding ASCII
Write-Host "Saved DPAPI-protected secret: $path"

if ($Kind -eq "totp") {
    & $nodeCommand.Source "$PSScriptRoot\src\show-totp.js"
    exit $LASTEXITCODE
}
