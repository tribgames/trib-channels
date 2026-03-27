# Claude2Bot Launcher Tray — Windows
# Run: powershell -ExecutionPolicy Bypass -File Claude2BotLauncher.ps1

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ── Paths ──
$ConfigPath = Join-Path $env:USERPROFILE ".claude2bot-launcher.json"
$StatePath = Join-Path $env:USERPROFILE ".claude2bot-launcher-state.json"
$PluginDataDir = Join-Path $env:USERPROFILE ".claude\plugins\data\claude2bot-claude2bot"
$BotConfigPath = Join-Path $PluginDataDir "bot.json"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
# Find launcher.mjs: local first, then plugin cache
$LauncherScript = Join-Path $ScriptDir "launcher.mjs"
if (-not (Test-Path $LauncherScript)) {
    $PluginCache = Join-Path $env:USERPROFILE ".claude\plugins\cache\claude2bot\claude2bot"
    $Found = Get-ChildItem $PluginCache -Recurse -Filter "launcher.mjs" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($Found) { $LauncherScript = $Found.FullName }
}
$SavedPATH = $env:PATH

# ── Helpers ──
function Read-Json($path) {
    if (Test-Path $path) {
        return Get-Content $path -Raw | ConvertFrom-Json
    }
    return $null
}

function Write-Json($path, $obj) {
    $obj | ConvertTo-Json -Depth 10 | Set-Content $path -Encoding UTF8
}

function Run-Launcher($args) {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { return }
    Start-Process -NoNewWindow -FilePath $node.Source -ArgumentList @($LauncherScript) + $args
}

function Run-LauncherSync($args) {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { return }
    $proc = Start-Process -NoNewWindow -FilePath $node.Source -ArgumentList @($LauncherScript) + $args -PassThru -Wait
}

function Run-LauncherHidden($args) {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { return }
    Start-Process -WindowStyle Hidden -FilePath $node.Source -ArgumentList @($LauncherScript) + $args
}

function Get-LauncherState {
    return Read-Json $StatePath
}

function Get-LauncherConfig {
    return Read-Json $ConfigPath
}

function Get-BotConfig {
    return Read-Json $BotConfigPath
}

function Set-Phase($phase) {
    $s = Get-LauncherState
    if (-not $s) { $s = [PSCustomObject]@{} }
    $s | Add-Member -NotePropertyName "phase" -NotePropertyValue $phase -Force
    Write-Json $StatePath $s
}

# ── Tray Icon ──
$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$iconPath = Join-Path $ScriptDir "icon.ico"
if (Test-Path $iconPath) {
    $notifyIcon.Icon = New-Object System.Drawing.Icon($iconPath)
} else {
    $notifyIcon.Icon = [System.Drawing.SystemIcons]::Application
}
$notifyIcon.Text = "Claude2Bot Launcher"
$notifyIcon.Visible = $true

# ── Context Menu ──
function Build-Menu {
    $menu = New-Object System.Windows.Forms.ContextMenuStrip

    $state = Get-LauncherState
    $config = Get-LauncherConfig
    $connected = $state.connected -eq $true
    $displayMode = if ($state.displayMode) { $state.displayMode } elseif ($config.displayMode) { $config.displayMode } else { "view" }

    # Status
    $statusText = if ($connected) { "● Connected" } else { "● Disconnected" }
    $statusItem = $menu.Items.Add($statusText)
    $statusItem.Enabled = $false

    $menu.Items.Add("-") | Out-Null

    # Launch
    $launchItem = $menu.Items.Add("Launch")
    $launchItem.Enabled = -not $connected
    $launchItem.Add_Click({ Run-Launcher @("launch") })

    # Restart
    $restartItem = $menu.Items.Add("Restart")
    $restartItem.Enabled = $connected
    $restartItem.Add_Click({
        Start-Job -ScriptBlock {
            param($script, $p)
            $env:PATH = $p
            $node = (Get-Command node).Source
            & $node $script stop | Out-Null
            & $node $script launch | Out-Null
        } -ArgumentList $LauncherScript, $SavedPATH
    })

    $menu.Items.Add("-") | Out-Null

    # View Mode
    $viewItem = $menu.Items.Add("View Mode")
    $viewItem.Checked = ($displayMode -eq "view")
    $viewItem.Add_Click({ Run-Launcher @("display", "view") })

    # Hide Mode
    $hideItem = $menu.Items.Add("Hide Mode")
    $hideItem.Checked = ($displayMode -eq "hide")
    $hideItem.Add_Click({ Run-Launcher @("display", "hide") })

    $menu.Items.Add("-") | Out-Null

    # Settings submenu
    $settingsItem = $menu.Items.Add("Settings")
    $settingsItem.Add_Click({ Show-Settings })

    $menu.Items.Add("-") | Out-Null

    # Quit
    $quitItem = $menu.Items.Add("Quit")
    $quitItem.Add_Click({
        Run-LauncherSync @("stop")
        $notifyIcon.Visible = $false
        $notifyIcon.Dispose()
        [System.Windows.Forms.Application]::Exit()
    })

    return $menu
}

# ── Settings Window ──
function Show-Settings {
    $config = Get-LauncherConfig
    $botConfig = Get-BotConfig
    $state = Get-LauncherState

    $form = New-Object System.Windows.Forms.Form
    $form.Text = "Claude2Bot Settings"
    $form.Size = New-Object System.Drawing.Size(380, 360)
    $form.StartPosition = "CenterScreen"
    $form.FormBorderStyle = "FixedDialog"
    $form.MaximizeBox = $false
    $form.MinimizeBox = $false

    $y = 15
    $labelX = 15
    $controlX = 220
    $controlW = 130

    # ── Workspace ──
    $wsLabel = New-Object System.Windows.Forms.Label
    $wsLabel.Text = "Workspace"
    $wsLabel.Font = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Bold)
    $wsLabel.Location = New-Object System.Drawing.Point($labelX, $y)
    $wsLabel.AutoSize = $true
    [void]$form.Controls.Add($wsLabel)

    $wsBtn = New-Object System.Windows.Forms.Button
    $wsBtn.Text = "Change..."
    $wsBtn.Location = New-Object System.Drawing.Point($controlX, ($y - 2))
    $wsBtn.Size = New-Object System.Drawing.Size($controlW, 24)
    $wsBtn.Add_Click({
        $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
        $dialog.Description = "Select workspace folder"
        if ($dialog.ShowDialog() -eq "OK") {
            Run-LauncherSync @("workspace", $dialog.SelectedPath)
            Start-Job -ScriptBlock {
                param($s, $p) $env:PATH = $p; $n = (Get-Command node).Source; & $n $s stop; & $n $s launch
            } -ArgumentList $LauncherScript, $SavedPATH
            $form.Close()
        }
    })
    [void]$form.Controls.Add($wsBtn)

    $y += 22
    $wsPath = if ($config.workspacePath) { $config.workspacePath } elseif ($state.workspacePath) { $state.workspacePath } else { "(not set)" }
    $wsPathLabel = New-Object System.Windows.Forms.Label
    $wsPathLabel.Text = $wsPath
    $wsPathLabel.ForeColor = [System.Drawing.Color]::Gray
    $wsPathLabel.Location = New-Object System.Drawing.Point($labelX, $y)
    $wsPathLabel.Size = New-Object System.Drawing.Size(340, 18)
    [void]$form.Controls.Add($wsPathLabel)

    $y += 30

    # ── Autotalk ──
    $atLabel = New-Object System.Windows.Forms.Label
    $atLabel.Text = "Autotalk"
    $atLabel.Location = New-Object System.Drawing.Point($labelX, ($y + 3))
    $atLabel.AutoSize = $true
    [void]$form.Controls.Add($atLabel)

    $atCombo = New-Object System.Windows.Forms.ComboBox
    $atCombo.Items.AddRange(@("OFF", "3/day", "5/day", "7/day", "10/day", "15/day"))
    $atCombo.DropDownStyle = "DropDownList"
    $atCombo.Location = New-Object System.Drawing.Point($controlX, $y)
    $atCombo.Size = New-Object System.Drawing.Size($controlW, 24)
    $atEnabled = $botConfig.autotalk.enabled -eq $true
    $atFreq = if ($botConfig.autotalk.freq) { $botConfig.autotalk.freq } else { 3 }
    $atCombo.SelectedIndex = if ($atEnabled) { $atFreq } else { 0 }
    $atCombo.Add_SelectedIndexChanged({
        $bot = Get-BotConfig
        if (-not $bot) { $bot = @{} }
        if (-not $bot.autotalk) { $bot | Add-Member -NotePropertyName autotalk -NotePropertyValue @{} -Force }
        if ($atCombo.SelectedIndex -eq 0) {
            $bot.autotalk.enabled = $false
        } else {
            $bot.autotalk.enabled = $true
            $bot.autotalk.freq = $atCombo.SelectedIndex
        }
        Write-Json $BotConfigPath $bot
    })
    [void]$form.Controls.Add($atCombo)

    $y += 32

    # ── Quiet Hours ──
    $qLabel = New-Object System.Windows.Forms.Label
    $qLabel.Text = "Quiet Hours"
    $qLabel.Location = New-Object System.Drawing.Point($labelX, ($y + 3))
    $qLabel.AutoSize = $true
    [void]$form.Controls.Add($qLabel)

    $qCombo = New-Object System.Windows.Forms.ComboBox
    $qCombo.Items.AddRange(@("OFF", "ON"))
    $qCombo.DropDownStyle = "DropDownList"
    $qCombo.Location = New-Object System.Drawing.Point($controlX, $y)
    $qCombo.Size = New-Object System.Drawing.Size($controlW, 24)
    $quietOn = $botConfig.quiet.schedule -and $botConfig.quiet.schedule -ne ""
    $qCombo.SelectedIndex = if ($quietOn) { 1 } else { 0 }
    [void]$form.Controls.Add($qCombo)

    $y += 30

    # Quiet From
    $qfLabel = New-Object System.Windows.Forms.Label
    $qfLabel.Text = "Quiet From"
    $qfLabel.Location = New-Object System.Drawing.Point($labelX, ($y + 3))
    $qfLabel.AutoSize = $true
    [void]$form.Controls.Add($qfLabel)

    $qfText = New-Object System.Windows.Forms.TextBox
    $qfText.Text = if ($botConfig.quiet.schedule) { ($botConfig.quiet.schedule -split "-")[0] } else { "22:00" }
    $qfText.Location = New-Object System.Drawing.Point($controlX, $y)
    $qfText.Size = New-Object System.Drawing.Size($controlW, 24)
    $qfText.TextAlign = "Center"
    $qfText.Enabled = $quietOn
    [void]$form.Controls.Add($qfText)

    $y += 30

    # Quiet To
    $qtLabel = New-Object System.Windows.Forms.Label
    $qtLabel.Text = "Quiet To"
    $qtLabel.Location = New-Object System.Drawing.Point($labelX, ($y + 3))
    $qtLabel.AutoSize = $true
    [void]$form.Controls.Add($qtLabel)

    $qtText = New-Object System.Windows.Forms.TextBox
    $qtText.Text = if ($botConfig.quiet.schedule) { ($botConfig.quiet.schedule -split "-")[1] } else { "08:00" }
    $qtText.Location = New-Object System.Drawing.Point($controlX, $y)
    $qtText.Size = New-Object System.Drawing.Size($controlW, 24)
    $qtText.TextAlign = "Center"
    $qtText.Enabled = $quietOn
    [void]$form.Controls.Add($qtText)

    $qCombo.Add_SelectedIndexChanged({
        $on = $qCombo.SelectedIndex -eq 1
        $qfText.Enabled = $on
        $qtText.Enabled = $on
        $bot = Get-BotConfig
        if (-not $bot) { $bot = @{} }
        if (-not $bot.quiet) { $bot | Add-Member -NotePropertyName quiet -NotePropertyValue @{} -Force }
        if ($on) {
            $bot.quiet.schedule = "$($qfText.Text)-$($qtText.Text)"
        } else {
            $bot.quiet.schedule = ""
        }
        Write-Json $BotConfigPath $bot
    })

    $y += 32

    # ── Sleeping Mode ──
    $slLabel = New-Object System.Windows.Forms.Label
    $slLabel.Text = "Sleeping Mode"
    $slLabel.Location = New-Object System.Drawing.Point($labelX, ($y + 3))
    $slLabel.AutoSize = $true
    [void]$form.Controls.Add($slLabel)

    $slCombo = New-Object System.Windows.Forms.ComboBox
    $slCombo.Items.AddRange(@("OFF", "ON"))
    $slCombo.DropDownStyle = "DropDownList"
    $slCombo.Location = New-Object System.Drawing.Point($controlX, $y)
    $slCombo.Size = New-Object System.Drawing.Size($controlW, 24)
    $sleepOn = if ($config.sleepEnabled -eq $false) { $false } else { $true }
    $slCombo.SelectedIndex = if ($sleepOn) { 1 } else { 0 }
    $slCombo.Add_SelectedIndexChanged({
        $c = Get-LauncherConfig; if (-not $c) { $c = @{} }
        $c.sleepEnabled = ($slCombo.SelectedIndex -eq 1)
        Write-Json $ConfigPath $c
    })
    [void]$form.Controls.Add($slCombo)

    $y += 30

    # Sleep Time
    $stLabel = New-Object System.Windows.Forms.Label
    $stLabel.Text = "Sleep Time"
    $stLabel.Location = New-Object System.Drawing.Point($labelX, ($y + 3))
    $stLabel.AutoSize = $true
    [void]$form.Controls.Add($stLabel)

    $stText = New-Object System.Windows.Forms.TextBox
    $stText.Text = if ($config.sleepTime) { $config.sleepTime } else { "03:00" }
    $stText.Location = New-Object System.Drawing.Point($controlX, $y)
    $stText.Size = New-Object System.Drawing.Size($controlW, 24)
    $stText.TextAlign = "Center"
    $stText.Enabled = $sleepOn
    $stText.Add_Leave({
        $c = Get-LauncherConfig; if (-not $c) { $c = @{} }
        $c.sleepTime = $stText.Text
        Write-Json $ConfigPath $c
    })
    [void]$form.Controls.Add($stText)

    $slCombo.Add_SelectedIndexChanged({
        $stText.Enabled = ($slCombo.SelectedIndex -eq 1)
    }.GetNewClosure())

    $y += 35

    # ── Bottom buttons ──
    $updateBtn = New-Object System.Windows.Forms.Button
    $updateBtn.Text = "Update Plugin"
    $updateBtn.Location = New-Object System.Drawing.Point($controlX, $y)
    $updateBtn.Size = New-Object System.Drawing.Size($controlW, 26)
    $updateBtn.Add_Click({ Run-Launcher @("update"); $form.Close() })
    [void]$form.Controls.Add($updateBtn)

    $form.ShowDialog()
}

# ── Timer (poll state every 5s) ──
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$lastSleepDate = ""
$script:launchGuard = $false

$timer.Add_Tick({
    # Check sleep schedule
    $config = Get-LauncherConfig
    $sleepEnabled = if ($config.sleepEnabled -eq $false) { $false } else { $true }
    if ($sleepEnabled) {
        $sleepTime = if ($config.sleepTime) { $config.sleepTime } else { "03:00" }
        $now = Get-Date -Format "HH:mm"
        $today = Get-Date -Format "yyyy-MM-dd"
        $endTime = ([datetime]::ParseExact($sleepTime, "HH:mm", $null)).AddMinutes(2).ToString("HH:mm")
        if ($now -ge $sleepTime -and $now -lt $endTime -and $lastSleepDate -ne $today) {
            $script:lastSleepDate = $today
            Start-Job -ScriptBlock {
                param($s, $p) $env:PATH = $p; $n = (Get-Command node).Source; & $n $s sleep-cycle
            } -ArgumentList $LauncherScript, $SavedPATH
        }
    }

    # Ensure launcher running (with guard to prevent double-launch)
    $state = Get-LauncherState
    $connected = $state.connected -eq $true
    $phase = $state.phase
    if (-not $connected -and -not $script:launchGuard -and $phase -notin @("launching", "sleeping", "warning_confirm", "connecting")) {
        $script:launchGuard = $true
        Run-LauncherHidden @("launch")
    }
    if ($connected) { $script:launchGuard = $false }
})
$timer.Start()

# Build menu on right-click (not on timer)
$notifyIcon.Add_MouseClick({
    if ($_.Button -eq [System.Windows.Forms.MouseButtons]::Right) {
        $notifyIcon.ContextMenuStrip = Build-Menu
    }
})

# ── Initial launch ──
Set-Phase "launching"
Start-Job -ScriptBlock {
    param($s, $p)
    $env:PATH = $p
    $n = (Get-Command node).Source
    & $n $s stop 2>&1 | Out-Null
    & $n $s install 2>&1 | Out-Null
    & $n $s launch 2>&1 | Out-Null
} -ArgumentList $LauncherScript, $SavedPATH

# ── Run ──
$notifyIcon.ContextMenuStrip = Build-Menu
[System.Windows.Forms.Application]::Run()
