@echo off
REM Called by Windows Task Scheduler: run-job.cmd <npm-script> [args...]
REM Logs to .claude\logs\<area>.log and a "lokal:<script>" row in SyncLog (scripts/runJob.ts).
setlocal
cd /d "%~dp0\.."
call npx.cmd tsx scripts/runJob.ts %*
exit /b %ERRORLEVEL%
