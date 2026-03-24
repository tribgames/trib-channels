@echo off
:loop
claude --chrome --dangerously-load-development-channels plugin:claude2bot@claude2bot
if not exist "%TEMP%\claude2bot-restart" (
  echo claude2bot: session ended normally.
  exit /b
)
set /p reason=<"%TEMP%\claude2bot-restart"
del "%TEMP%\claude2bot-restart"
echo claude2bot: restarting (%reason%)...
timeout /t 2 /nobreak >nul
goto loop
