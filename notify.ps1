param(
    [Parameter(Mandatory = $true)]
    [string]$Title,
    [Parameter(Mandatory = $true)]
    [string]$Message,
    [ValidateSet("Info", "Warning", "Error")]
    [string]$Icon = "Info"
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# A console script runs no Windows message loop by default, and NotifyIcon's
# hidden window needs one to actually process the balloon tip; without this,
# ShowBalloonTip is a no-op that neither shows anything nor errors.
$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Icon = [System.Drawing.SystemIcons]::Information
$notifyIcon.Visible = $true
$notifyIcon.BalloonTipTitle = $Title
$notifyIcon.BalloonTipText = $Message
$notifyIcon.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::$Icon

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 6000
$timer.Add_Tick({
    $timer.Stop()
    $notifyIcon.Dispose()
    [System.Windows.Forms.Application]::ExitThread()
})
$notifyIcon.Add_BalloonTipClosed({
    $timer.Stop()
    $notifyIcon.Dispose()
    [System.Windows.Forms.Application]::ExitThread()
})

$notifyIcon.ShowBalloonTip(10000)
$timer.Start()
[System.Windows.Forms.Application]::Run()
