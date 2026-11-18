# Install (or update) every Windows Scheduled Task for the Betting Tracker models.
# Each task runs scripts\run-job.cmd <npm-script> [args], which logs to
# .claude\logs\<area>.log, returns the script's real exit code, writes a
# "lokal:<script>" row to SyncLog (the pages' "Uppdaterad" indicator) and sends
# an ntfy alert on failure (NTFY_TOPIC), at most one per job and day.
#
#   BettingTracker-Shots       daily 09:00 - Sofascore fixtures + stats for every shot league
#   BettingTracker-Cs2Update   daily 10:00 - HLTV ingest (Scrapling, hidden), demos, Unibet lines, facit
#   BettingTracker-Cs2Lines    every 2 h 12:00-22:00 - Unibet lines only, closer to match start
#   BettingTracker-NbaUpdate   daily 13:00 - results, injuries, odds (1 OddsPapi request), projections
#   BettingTracker-NbaClosing  daily 23:30 - injuries + closing odds (1 OddsPapi request)
#   BettingTracker-NbaLineups  every 30 min 00:00-04:00 - starting fives from ESPN
#   BettingTracker-NbaSmarkets every hour 12:00-03:00 - Smarkets prices
#   BettingTracker-NbaLive     daily 12:00, runs until 06:00 - live watch, ntfy alerts
#
#   npm run install:tasks
#   npm run install:tasks -- -NbaResumeAt "2026-12-01 06:00"
#
# -NbaResumeAt disables the five NBA tasks now and registers a one-shot task,
# BettingTracker-NbaResume, that enables them again at that time and then
# removes itself. Used while the NBA database's Neon quota is exhausted.
#
# Run from the main checkout: the tasks run scripts from the folder this file is in.
#
# Remove everything with:
#   Get-ScheduledTask BettingTracker-* | Unregister-ScheduledTask -Confirm:$false

param(
  [string]$ShotsAt = "09:00",
  [string]$Cs2At = "10:00",
  [string]$Cs2LinesFrom = "12:00",
  [int]$Cs2LinesHours = 10,
  [string]$UpdateAt = "13:00",
  [string]$ClosingAt = "23:30",
  [string]$LineupsFrom = "00:00",
  [int]$LineupsHours = 4,
  [string]$SmarketsFrom = "12:00",
  [int]$SmarketsHours = 15,
  [string]$LiveFrom = "12:00",
  [string]$NbaResumeAt = ""
)

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Runner = Join-Path $PSScriptRoot "run-job.cmd"
if (-not (Test-Path $Runner)) {
  throw "Missing runner script: $Runner"
}
New-Item -ItemType Directory -Force -Path (Join-Path $RepoRoot ".claude\logs") | Out-Null

$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

$NbaNames = @("BettingTracker-NbaUpdate", "BettingTracker-NbaClosing", "BettingTracker-NbaLineups", "BettingTracker-NbaSmarkets", "BettingTracker-NbaLive")

$Tasks = @(
  @{
    Name = "BettingTracker-Shots"
    Job = "shots:ingest --league all --confirm"
    At = $ShotsAt
    # Catch up after the PC was off - fixtures for the coming days are still useful.
    StartWhenAvailable = $true
    ExecutionHours = 3
    Description = "Betting Tracker: Sofascore fixtures and team stats for the shot model."
  },
  @{
    Name = "BettingTracker-Cs2Update"
    Job = "cs2:update --scrapling --headless"
    At = $Cs2At
    StartWhenAvailable = $true
    ExecutionHours = 3
    Description = "Betting Tracker: HLTV ingest (Scrapling, hidden window), demos, Unibet lines, facit and roles."
  },
  @{
    Name = "BettingTracker-Cs2Lines"
    Job = "cs2:lines"
    At = $Cs2LinesFrom
    RepeatMinutes = 120
    RepeatHours = $Cs2LinesHours
    StartWhenAvailable = $false
    Description = "Betting Tracker: Unibet CS2 lines for upcoming matches (no browser)."
  },
  @{
    Name = "BettingTracker-NbaUpdate"
    Job = "nba:update"
    At = $UpdateAt
    StartWhenAvailable = $true
    Description = "Betting Tracker: NBA results, injuries, OddsPapi odds (1 request), projections and settlement."
  },
  @{
    Name = "BettingTracker-NbaClosing"
    Job = "nba:closing"
    At = $ClosingAt
    # No catch-up: a closing run the next morning would only spend a request on finished games.
    StartWhenAvailable = $false
    Description = "Betting Tracker: NBA injuries and closing odds (1 OddsPapi request) before tip-off."
  },
  @{
    Name = "BettingTracker-NbaLineups"
    Job = "nba:lineups"
    At = $LineupsFrom
    RepeatMinutes = 30
    RepeatHours = $LineupsHours
    StartWhenAvailable = $false
    Description = "Betting Tracker: NBA starting fives from ESPN (free) and re-pricing near tip-off."
  },
  @{
    Name = "BettingTracker-NbaSmarkets"
    Job = "nba:smarkets"
    At = $SmarketsFrom
    RepeatMinutes = 60
    RepeatHours = $SmarketsHours
    StartWhenAvailable = $false
    Description = "Betting Tracker: Smarkets NBA prices every hour (free) - our own Smarkets history."
  },
  @{
    Name = "BettingTracker-NbaLive"
    Job = "nba:live-watch"
    At = $LiveFrom
    # Runs all afternoon and night; the script stops itself at 06.
    ExecutionHours = 19
    StartWhenAvailable = $true
    Description = "Betting Tracker: live watch for slow Kambi NBA lines vs Pinnacle, phone alerts via ntfy."
  }
)

foreach ($t in $Tasks) {
  # run-job.cmd stops the job (with every child process) 10 min before the Task
  # Scheduler limit: the scheduler's own limit only kills cmd.exe, and node kept
  # running for 11 h. The scheduler limit stays as a backstop.
  $MaxMinutes = if ($t.ExecutionHours) { $t.ExecutionHours * 60 - 10 } else { 25 }
  $Action = New-ScheduledTaskAction -Execute $Runner -Argument "--max-minutes $MaxMinutes $($t.Job)" -WorkingDirectory $RepoRoot
  $Trigger = New-ScheduledTaskTrigger -Daily -At $t.At
  if ($t.RepeatMinutes) {
    $Trigger.Repetition = (New-ScheduledTaskTrigger -Once -At $t.At `
      -RepetitionInterval (New-TimeSpan -Minutes $t.RepeatMinutes) `
      -RepetitionDuration (New-TimeSpan -Hours $t.RepeatHours)).Repetition
  }
  $Limit = if ($t.ExecutionHours) { New-TimeSpan -Hours $t.ExecutionHours } else { New-TimeSpan -Minutes 30 }
  if ($t.StartWhenAvailable) {
    $Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
      -MultipleInstances IgnoreNew -ExecutionTimeLimit $Limit
  } else {
    $Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -MultipleInstances IgnoreNew -ExecutionTimeLimit $Limit
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
  Write-Host "Installed '$($t.Name)': $($t.Job), $When, stopped after $MaxMinutes min."
}

if ($NbaResumeAt) {
  $ResumeAt = [datetime]::Parse($NbaResumeAt)
  foreach ($n in $NbaNames) { Disable-ScheduledTask -TaskName $n | Out-Null }
  $Cmd = "Get-ScheduledTask -TaskName 'BettingTracker-Nba*' | Where-Object TaskName -ne 'BettingTracker-NbaResume' | Enable-ScheduledTask; " +
    "Unregister-ScheduledTask -TaskName 'BettingTracker-NbaResume' -Confirm:`$false"
  $Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -Command `"$Cmd`""
  $Trigger = New-ScheduledTaskTrigger -Once -At $ResumeAt
  $Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
  Register-ScheduledTask -TaskName "BettingTracker-NbaResume" -Action $Action -Trigger $Trigger -Settings $Settings `
    -Principal $Principal -Description "Betting Tracker: enables the NBA tasks again, then removes itself." -Force | Out-Null
  Write-Host ""
  Write-Host "NBA tasks disabled. BettingTracker-NbaResume enables them at $($ResumeAt.ToString('yyyy-MM-dd HH:mm'))."
}

Write-Host ""
Write-Host "Runs while you are logged in. Logs: $(Join-Path $RepoRoot '.claude\logs')"
Write-Host "Verify:  Get-ScheduledTask BettingTracker-* | Select TaskName,State"
Write-Host "Run now: Start-ScheduledTask -TaskName BettingTracker-Shots"
