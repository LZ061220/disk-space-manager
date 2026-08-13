@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js。请先安装 Node.js LTS 后再运行此文件。
  pause
  exit /b 1
)
echo 正在启动本地服务。请在浏览器中打开下面显示的地址；关闭此窗口会停止服务。
node disk-space-manager.js
