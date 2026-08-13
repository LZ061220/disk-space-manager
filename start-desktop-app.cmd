@echo off
setlocal
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo 尚未安装桌面应用依赖。
  echo 请先运行 install-desktop-dependencies.cmd。
  pause
  exit /b 1
)
call "node_modules\.bin\electron.cmd" "%~dp0"
