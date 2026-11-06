@echo off
rem Starts Hypersuperfluid with all of its state inside this folder: sessions, settings, keys entered in Settings,
rem memory, learned skills, the ERP environment and browser data. Copy the folder to move everything; delete it to
rem remove everything.
setlocal
set "HERE=%~dp0"
set "DSH_HOME=%HERE%data\home"
rem API keys dropped here as keys.env or .env, or sealed as keys.sealed, are encrypted on first start and the files
rem deleted. CareerOps, when shipped, sits in career-ops\ here.
set "HSF_PORTABLE_ROOT=%HERE:~0,-1%"
if not exist "%DSH_HOME%" mkdir "%DSH_HOME%"
if not exist "%HERE%data\app" mkdir "%HERE%data\app"
start "" "%HERE%app\Hypersuperfluid.exe" --user-data-dir="%HERE%data\app" %*
