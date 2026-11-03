@echo off
REM Called by Windows Task Scheduler: run-nba.cmd update | closing | lineups | smarkets | live-watch
REM Logs to .claude\logs\nba.log in the repo.
setlocal
cd /d "%~dp0\.."
if not exist ".claude\logs" mkdir ".claude\logs"
set "JOB=%~1"
if "%JOB%"=="" set "JOB=update"
echo [%date% %time%] nba:%JOB% start>> ".claude\logs\nba.log"
call npm.cmd run nba:%JOB% >> ".claude\logs\nba.log" 2>&1
echo [%date% %time%] nba:%JOB% done exit=%ERRORLEVEL%>> ".claude\logs\nba.log"
endlocal
