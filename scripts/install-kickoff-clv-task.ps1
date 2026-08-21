# Install (or update) a Windows Scheduled Task that captures near-kickoff CLV
# every 10 minutes while you are logged in.
#
#   npm run install:kickoff-clv-task
#
# Remove with:
#   Unregister-ScheduledTask -TaskName "BettingTracker-KickoffClv" -Confirm:$false

$ErrorActionPreference = "Stop"

$TaskName = "BettingTracker-KickoffClv"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Runner = Join-Path $PSScriptRoot "run-kickoff-clv.cmd"
$LogFile = Join-Path $RepoRoot ".claude\logs\kickoff-clv.log"

if (-not (Test-Path $Runner)) {
  throw "Missing runner script: $Runner"
}

New-Item -ItemType Directory -Force -Path (Split-Path $LogFile) | Out-Null

$Action = New-ScheduledTaskAction -Execute $Runner -WorkingDirectory $RepoRoot

# Daily trigger that repeats every 10 minutes for 24h (re-arms each day).
$Trigger = New-ScheduledTaskTrigger -Daily -At "00:05"
$Trigger.Repetition = (New-ScheduledTaskTrigger -Once -At "00:05" `
  -RepetitionInterval (New-TimeSpan -Minutes 10) `
  -RepetitionDuration (New-TimeSpan -Hours 23 -Minutes 50)).Repetition

$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 8)
$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $Action `
  -Trigger $Trigger `
  -Settings $Settings `
  -Principal $Principal `
  -Description "Betting Tracker: capture Odds API closing odds 10-30 min before kickoff (every 10 min)." `
  -Force | Out-Null

Write-Host "Installed scheduled task '$TaskName'."
Write-Host "  Runs every 10 minutes while you are logged in."
Write-Host "  Window: T-30 ... T+5 minutes."
Write-Host "  Log: $LogFile"
Write-Host ""
Write-Host "Verify:  Get-ScheduledTask -TaskName $TaskName"
Write-Host "Run now: Start-ScheduledTask -TaskName $TaskName"
Write-Host "Remove:  Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"
