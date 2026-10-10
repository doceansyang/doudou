@echo off
chcp 65001 >nul
title JinyuTV 更新并重启
cd /d "%~dp0"

set "PY=C:\Users\JinYuDream\.workbuddy\binaries\python\envs\default\Scripts\python.exe"
if not exist "%PY%" (
  echo [错误] 找不到 Python：%PY%
  pause
  exit /b 1
)

echo ============================================
echo  JinyuTV 更新流程
echo   1. 重新构建项目产物
echo   2. 同步到软件目录
echo   3. 重启软件并自检
echo ============================================
echo.

"%PY%" scripts\dev-update.py %*

echo.
echo 完成。按任意键关闭本窗口（软件已在后台运行）。
pause >nul
