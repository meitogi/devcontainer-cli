@echo off
REM Thin wrapper so Windows users can double-click or type `.\run-tests.cmd`
REM instead of `node run-tests.js`. WSL / Linux users invoke run-tests.js
REM directly (same code, same behaviour).
node "%~dp0run-tests.js" %*
