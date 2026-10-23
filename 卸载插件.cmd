@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
if not exist "%~dp0package.json" goto incomplete
if not exist "%~dp0.codex-plugin\plugin.json" goto incomplete
if not exist "%~dp0scripts\uninstall.mjs" goto incomplete
if not exist "%~dp0src\paths.mjs" goto incomplete
if not exist "%~dp0src\runtime.mjs" goto incomplete
where node >nul 2>&1
if errorlevel 1 goto node_required
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)" >nul 2>&1
if errorlevel 1 goto node_required
node "%~dp0scripts\uninstall.mjs"
set "scheduler_exit_code=%errorlevel%"
pause
exit /b %scheduler_exit_code%

:incomplete
rem Encoded Chinese instructions avoid CMD multibyte parsing issues.
powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand WwBDAG8AbgBzAG8AbABlAF0AOgA6AE8AdQB0AHAAdQB0AEUAbgBjAG8AZABpAG4AZwAgAD0AIABbAFMAeQBzAHQAZQBtAC4AVABlAHgAdAAuAFUAVABGADgARQBuAGMAbwBkAGkAbgBnAF0AOgA6AG4AZQB3ACgAJABmAGEAbABzAGUAKQA7ACAAWwBDAG8AbgBzAG8AbABlAF0AOgA6AFcAcgBpAHQAZQBMAGkAbgBlACgAJwB4U32PKmdnYkyIGv9TX01S7nZVXzp/EVyMW3RlhHbSY/ZOh2X2Tgz/0mP2ToxUTGhil2VR41MaXCpnIFJklgIwJwApADsAIABbAEMAbwBuAHMAbwBsAGUAXQA6ADoAVwByAGkAdABlAEwAaQBuAGUAKAAnAPeLSFHzUy6VIABaAEkAUAAgAAmQ6WJoUeiQ44mLUyl/DP+NUVNiAF/jiYtTDlSEdodl9k45WdCPTIh4U32P0mP2Ti4AYwBtAGQAAjAnACkAOwAgAFsAQwBvAG4AcwBvAGwAZQBdADoAOgBXAHIAaQB0AGUATABpAG4AZQAoACcADU6BiShXi1MpfwVTl3rjUy1O9HalY9CPTIgb//eLbnikiwxUAE6HZfZOOVmFUQlnIABzAGMAcgBpAHAAdABzAAEwcwByAGMAIACMVCAAcABhAGMAawBhAGcAZQAuAGoAcwBvAG4AAjAnACkA
pause
exit /b 1

:node_required
powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand WwBDAG8AbgBzAG8AbABlAF0AOgA6AE8AdQB0AHAAdQB0AEUAbgBjAG8AZABpAG4AZwAgAD0AIABbAFMAeQBzAHQAZQBtAC4AVABlAHgAdAAuAFUAVABGADgARQBuAGMAbwBkAGkAbgBnAF0AOgA6AG4AZQB3ACgAJABmAGEAbABzAGUAKQA7ACAAWwBDAG8AbgBzAG8AbABlAF0AOgA6AFcAcgBpAHQAZQBMAGkAbgBlACgAJwAaXCpnZ2JMiBr/AJeBiSAATgBvAGQAZQAuAGoAcwAgADIAMgAgABZi9GbYmkhyLGcCMCcAKQA7ACAAWwBDAG8AbgBzAG8AbABlAF0AOgA6AFcAcgBpAHQAZQBMAGkAbgBlACgAJwD3i0hRiVvFiCAATgBvAGQAZQAuAGoAcwAgADIAMgArAAz/zZGwZVNiAF+JW8WIh2X2TjlZDP+NUdCPTIhka2VR41MCMOBlAJcgAG4AcABtACAAaQBuAHMAdABhAGwAbAACMCcAKQA7AA==
pause
exit /b 1
