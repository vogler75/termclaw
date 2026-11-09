@echo off
rem Builds TermClaw for Windows.
rem
rem   build.bat           installer + portable exe + unpacked app
rem   build.bat dir       only the unpacked app (win-unpacked), fastest
rem   build.bat test      run the unit tests, then build everything
rem
rem Output goes to %USERPROFILE%\termclaw-release, or to TERMCLAW_RELEASE_DIR if set. It is outside
rem the project because an editor with the project open (e.g. Orca) can lock the .asar files in it.
rem
setlocal
cd /d "%~dp0"
if not defined TERMCLAW_RELEASE_DIR set "TERMCLAW_RELEASE_DIR=%USERPROFILE%\termclaw-release"

where npm >nul 2>nul || (echo npm not found. Install Node.js 22 or newer. & exit /b 1)

if not exist node_modules (
  echo Installing dependencies...
  call npm install || exit /b 1
)

if /i "%~1"=="test" (
  echo Running unit tests...
  call npm test || exit /b 1
)

rem Version from version.txt into package.json (app, exe file version, artifact names)
call node scripts\version.js || exit /b 1

echo Building renderer and MCP bridge...
call node scripts\build-renderer.js || exit /b 1

if /i "%~1"=="dir" (
  echo Packaging unpacked app...
  call npx electron-builder --win dir "-c.directories.output=%TERMCLAW_RELEASE_DIR%" || goto failed
) else (
  echo Packaging installer, portable exe and unpacked app...
  call npx electron-builder --win "-c.directories.output=%TERMCLAW_RELEASE_DIR%" || goto failed
)

echo.
echo Done. Output in %TERMCLAW_RELEASE_DIR%
exit /b 0

:failed
echo.
echo Build failed. If it says "resource busy or locked", another program has files open in %TERMCLAW_RELEASE_DIR%: close TermClaw if it runs from there, or any editor showing that folder, and try again.
exit /b 1
