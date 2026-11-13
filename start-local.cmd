@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto use_mise
node -e "var p=process.versions.node.split('.');process.exit(Number(p[0])>22||(Number(p[0])===22&&Number(p[1])>=12)?0:1)" >nul 2>nul
if errorlevel 1 goto use_mise
node scripts/start-local.mjs
set "uno_exit_code=%errorlevel%"
goto finished

:use_mise
where mise >nul 2>nul
if errorlevel 1 goto missing_node
echo Using Node.js 24 through mise...
call mise exec node@24 -- node scripts/start-local.mjs
set "uno_exit_code=%errorlevel%"
goto finished

:missing_node
echo Node.js 22.12 or newer is required. With mise installed, run:
echo   mise install node@24
echo   mise exec node@24 -- node scripts/start-local.mjs
echo Or install Node.js LTS from https://nodejs.org and open a new terminal.
pause
exit /b 1

:finished
pause
exit /b %uno_exit_code%
