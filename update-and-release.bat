@echo off
setlocal
rem Long-running and RESUMABLE: updates the upstream pins, rebuilds every changed engine, tests, packs a local release\ (the version is raised by the release workflow at the merge into main).
rem If it stops (error, reboot, window closed, kill), run the same command again: it continues from logs\update-state.json.
rem   update-and-release.bat            start an update, or continue the unfinished one
rem   update-and-release.bat --force    rebuild and re-release even without a newer upstream release
rem   update-and-release.bat --commit   commit on success (never pushes)
rem   update-and-release.bat --status   show the tracked progress
rem   update-and-release.bat --resume   also adopt an interrupted run that left no state file
rem   update-and-release.bat --rollback discard the unfinished update
rem Duration: up to ~2 hours (one rustc job at a time).
rem Logs: logs\update-*.log (full output), logs\update-state.json (progress), logs\last-error.txt, logs\llm-handoff.md (compile errors for the LLM), logs\launcher.log (this script).
cd /d "%~dp0"
title artcraft-web update and release
if not exist logs mkdir logs
set "LAUNCHER=%~dp0logs\launcher.log"
echo [%DATE% %TIME%] start args="%*" >> "%LAUNCHER%"
if not defined ARTCRAFT_TARGET_DIR set "ARTCRAFT_TARGET_DIR=%TEMP%\artcraft-target"
where node >> "%LAUNCHER%" 2>&1
if errorlevel 1 (
  echo [%DATE% %TIME%] ERRORE: node non trovato nel PATH >> "%LAUNCHER%"
  echo ERRORE: node non trovato nel PATH. Vedi logs\launcher.log
  set "RC=9009"
  goto :end
)
if not exist node_modules\binaryen (
  echo [%DATE% %TIME%] npm install >> "%LAUNCHER%"
  call npm install --no-audit --no-fund >> "%LAUNCHER%" 2>&1
  if errorlevel 1 (
    echo [%DATE% %TIME%] ERRORE: npm install fallito >> "%LAUNCHER%"
    echo ERRORE: npm install fallito. Vedi logs\launcher.log
    set "RC=1"
    goto :end
  )
)
node scripts\update-and-release.mjs %*
set "RC=%ERRORLEVEL%"
:end
rem The cargo targets are kept after a failure: they let the resumed run continue the compilation.
if "%RC%"=="0" if exist "%ARTCRAFT_TARGET_DIR%" rmdir /s /q "%ARTCRAFT_TARGET_DIR%"
echo [%DATE% %TIME%] fine, codice %RC% >> "%LAUNCHER%"
echo.
if "%RC%"=="0" (echo OK: vedi release\ e logs\) else (echo ERRORE %RC%: rilancia lo stesso comando per riprendere. Vedi logs\last-error.txt e logs\update-state.json)
pause
exit /b %RC%
