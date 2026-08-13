@echo off
setlocal
cd /d "%~dp0"
where npm >nul 2>nul
if errorlevel 1 (
  echo 未找到 npm。请先安装 Node.js LTS，并确认 node 和 npm 已加入 PATH。
  pause
  exit /b 1
)
echo 正在安装桌面窗口依赖，这一步需要网络连接。
call npm install
if errorlevel 1 (
  echo 安装失败，请检查网络或稍后重试。
  pause
  exit /b 1
)
echo 安装完成，现在可以双击 start-desktop-app.cmd。
pause
