# Install (or update) two Windows Scheduled Tasks for the NBA model:
#
#   BettingTracker-NbaUpdate   daily at 09:00 - results, injuries, odds, projections, settle
#   BettingTracker-NbaClosing  daily at 23:45 - injuries + closing odds before tip-off
#
#   npm run install:nba-tasks
#   npm run install:nba-tasks -- -MorningAt 08:30 -ClosingAt 23:30
#
# Each run costs 1 OddsPapi request (about 60 of the free 250 a month).
# Why 23:45 and not later: most NBA games tip at 00:00-02:00 Swedish time, so
# the closing run has to happen before the first of them. It prices every game
# starting within 4 hours and marks lines as closing for games within 3 hours.
#
# Remove with:
#   Unregister-ScheduledTask -TaskName "BettingTracker-NbaUpdate" -Confirm:$false
#   Unregister-ScheduledTask -TaskName "BettingTracker-NbaClosing" -Confirm:$false

param(
  [string]$MorningAt = "09:00",
  [string]$ClosingAt = "23:45"
)

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Runner = Join-Path $PSScriptRoot "run-nba.cmd"
$LogFile = Join-Path $RepoRoot ".claude\logs\nba.log"

if (-not (Test-Path $Runner)) {
  throw "Missing runner script: $Runner"
}

New-Item -ItemType Directory -Force -Path (Split-Path $LogFile) | Out-Null

$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

$Tasks = @(
  @{
    Name = "BettingTracker-NbaUpdate"
    Job = "update"
    At = $MorningAt
    # Catch up if the PC was off at 09:00 - results and projections are still useful later in the day.
    StartWhenAvailable = $true
    Description = "Betting Tracker: NBA results, injuries, OddsPapi odds (1 request), projections and settlement."
  },
  @{
    Name = "BettingTracker-NbaClosing"
    Job = "closing"
    At = $ClosingAt
    # No catch-up: a closing run the next morning would only spend a request on finished games.
    StartWhenAvailable = $false
    Description = "Betting Tracker: NBA injuries and closing odds (1 OddsPapi request) before tip-off."
  }
)

foreach ($t in $Tasks) {
  $Action = New-ScheduledTaskAction -Execute $Runner -Argument $t.Job -WorkingDirectory $RepoRoot
  $Trigger = New-ScheduledTaskTrigger -Daily -At $t.At
  if ($t.StartWhenAvailable) {
    $Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
      -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
  } else {
    $Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
  }
  Register-ScheduledTask `
    -TaskName $t.Name `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Principal $Principal `
    -Description $t.Description `
    -Force | Out-Null
  Write-Host "Installed '$($t.Name)': npm run nba:$($t.Job) daily at $($t.At)."
}

Write-Host ""
Write-Host "Runs while you are logged in. Log: $LogFile"
Write-Host ""
Write-Host "Verify:  Get-ScheduledTask -TaskName BettingTracker-Nba*"
Write-Host "Run now: Start-ScheduledTask -TaskName BettingTracker-NbaUpdate"
Write-Host "Remove:  Unregister-ScheduledTask -TaskName BettingTracker-NbaUpdate -Confirm:`$false"
Write-Host "         Unregister-ScheduledTask -TaskName BettingTracker-NbaClosing -Confirm:`$false"
