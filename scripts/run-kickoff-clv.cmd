@echo off
REM Called by Windows Task Scheduler every 10 minutes.
setlocal
cd /d "%~dp0\.."
if not exist ".claude\logs" mkdir ".claude\logs"
echo [%date% %time%] kickoff-clv start>> ".claude\logs\kickoff-clv.log"
call npm.cmd run capture:kickoff-clv -- --confirm --before 30 --after 5 >> ".claude\logs\kickoff-clv.log" 2>&1
echo [%date% %time%] kickoff-clv done exit=%ERRORLEVEL%>> ".claude\logs\kickoff-clv.log"
endlocal
