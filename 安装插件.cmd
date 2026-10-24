@echo off
chcp 65001 >nul
setlocal DisableDelayedExpansion
set "PSModulePath="
set "scheduler_root=%~dp0"
set "scheduler_pause=1"
set "scheduler_dry_run="
:parse_arguments
if "%~1"=="" goto start
if /i "%~1"=="--no-pause" goto no_pause
if /i "%~1"=="--dry-run" goto dry_run
echo Unsupported argument. Supported: --dry-run --no-pause
set "scheduler_exit_code=2"
goto finish
:no_pause
set "scheduler_pause=0"
shift
goto parse_arguments
:dry_run
set "scheduler_dry_run=-DryRun"
shift
goto parse_arguments
:start
if not exist "%scheduler_root%scripts\bootstrap.ps1" goto incomplete
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%scheduler_root%scripts\bootstrap.ps1" -Action install %scheduler_dry_run%
set "scheduler_exit_code=%errorlevel%"
goto finish
:incomplete
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -EncodedCommand WwBDAG8AbgBzAG8AbABlAF0AOgA6AE8AdQB0AHAAdQB0AEUAbgBjAG8AZABpAG4AZwAgAD0AIABOAGUAdwAtAE8AYgBqAGUAYwB0ACAAUwB5AHMAdABlAG0ALgBUAGUAeAB0AC4AVQBUAEYAOABFAG4AYwBvAGQAaQBuAGcAKAAkAGYAYQBsAHMAZQApADsAIABbAEMAbwBuAHMAbwBsAGUAXQA6ADoAVwByAGkAdABlAEwAaQBuAGUAKAAnAM1kXE8qZ2diTIga/4lbxYgFUw1OjFt0ZQIw94vzUy6VIABaAEkAUAAgAAmQ6WJoUeiQ44mLUyl/DP9TYgBf44mLUw5UhHaHZfZOOVmNUdCPTIhlUeNTAjAnACkA
set "scheduler_exit_code=1"
:finish
if "%scheduler_pause%"=="1" pause
exit /b %scheduler_exit_code%
