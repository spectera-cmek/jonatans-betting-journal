# Install (or update) two Windows Scheduled Tasks for the NBA model:
#
#   BettingTracker-NbaUpdate   daily at 13:00 - last night's results and settlement,
#                              injuries, odds, projections and locked picks
#   BettingTracker-NbaClosing  daily at 23:30 - injuries + closing odds before tip-off
#   BettingTracker-NbaLineups  every 30 min 00:00-04:00 - starting fives from ESPN (free,
#                              no OddsPapi request), re-prices games starting within 90 min
#
#   npm run install:nba-tasks
#   npm run install:nba-tasks -- -UpdateAt 12:00 -ClosingAt 23:00
#
# Each run costs 1 OddsPapi request (about 60 of the free 250 a month).
# 13:00: the night's games are long finished and the books have posted
# tonight's lines. 23:30: before the first tip-off (most games start at
# 00:00-02:00 Swedish time); it prices every game starting within 4 hours and
# marks lines as closing for games within 3 hours.
#
# Remove with:
#   Unregister-ScheduledTask -TaskName "BettingTracker-NbaUpdate" -Confirm:$false
#   Unregister-ScheduledTask -TaskName "BettingTracker-NbaClosing" -Confirm:$false

param(
  [string]$UpdateAt = "13:00",
  [string]$ClosingAt = "23:30",
  [string]$LineupsFrom = "00:00",
  [int]$LineupsHours = 4
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
    At = $UpdateAt
    # Catch up if the PC was off at 13:00 - results and projections are still useful later in the day.
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
  },
  @{
    Name = "BettingTracker-NbaLineups"
    Job = "lineups"
    At = $LineupsFrom
    # Var 30:e minut under natten - startfemmorna publiceras ~30 min före varje match.
    RepeatMinutes = 30
    RepeatHours = $LineupsHours
    StartWhenAvailable = $false
    Description = "Betting Tracker: NBA starting fives from ESPN (free) and re-pricing near tip-off."
  }
)

foreach ($t in $Tasks) {
  $Action = New-ScheduledTaskAction -Execute $Runner -Argument $t.Job -WorkingDirectory $RepoRoot
  $Trigger = New-ScheduledTaskTrigger -Daily -At $t.At
  if ($t.RepeatMinutes) {
    $Trigger.Repetition = (New-ScheduledTaskTrigger -Once -At $t.At `
      -RepetitionInterval (New-TimeSpan -Minutes $t.RepeatMinutes) `
      -RepetitionDuration (New-TimeSpan -Hours $t.RepeatHours)).Repetition
  }
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
  $When = if ($t.RepeatMinutes) { "every $($t.RepeatMinutes) min for $($t.RepeatHours) h from $($t.At)" } else { "daily at $($t.At)" }
  Write-Host "Installed '$($t.Name)': npm run nba:$($t.Job) $When."
}

Write-Host ""
Write-Host "Runs while you are logged in. Log: $LogFile"
Write-Host ""
Write-Host "Verify:  Get-ScheduledTask -TaskName BettingTracker-Nba*"
Write-Host "Run now: Start-ScheduledTask -TaskName BettingTracker-NbaUpdate"
Write-Host "Remove:  Unregister-ScheduledTask -TaskName BettingTracker-NbaUpdate -Confirm:`$false"
Write-Host "         Unregister-ScheduledTask -TaskName BettingTracker-NbaClosing -Confirm:`$false"
Write-Host "         Unregister-ScheduledTask -TaskName BettingTracker-NbaLineups -Confirm:`$false"
