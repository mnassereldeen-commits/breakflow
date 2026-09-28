@echo off
title BreakFlow - Xcally bridge setup
echo Setting up the Xcally bridge on this PC...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install.ps1"
echo.
pause
