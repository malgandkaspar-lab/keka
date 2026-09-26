@echo off
rem Double-click to set up Shorts Factory on Windows (bypasses the PowerShell script policy for this run only).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
pause
