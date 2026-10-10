@echo off
chcp 65001 >nul
title Toonflow 启动器

rem 定位到仓库根目录：脚本放在仓库根时 %~dp0 就是根；
rem 若被放进 scripts\ 子目录，则回退一级。两种布局都能工作。
cd /d "%~dp0"
if not exist "build\server\index.js" cd /d "%~dp0.."

set "BUN=C:\Users\JinYuDream\.workbuddy\tools\bun\bun.exe"
if not exist "%BUN%" (
  echo [错误] 找不到 bun：%BUN%
  echo 请修改本脚本里的 BUN 路径。
  pause
  exit /b 1
)

if not exist "build\server\index.js" (
  echo [错误] 找不到 build\server\index.js
  echo 当前目录：%CD%
  pause
  exit /b 1
)

if not exist "logs" mkdir "logs"

echo 正在启动 Toonflow…（服务端日志写入 logs\server.log）
echo.
echo   · 主服务（端口 3000）启动后会**自动拉起**豆包 RPA 服务（端口 18077），无需单独启动。
echo   · 本机若有 HTTP 代理，服务已自行让 127.0.0.1 绕过代理，无需额外设置。

rem 日志落盘：出问题时可以直接看 logs\server.log，不必再靠截屏猜。
start "Toonflow 服务 (:3000)" cmd /c ""%BUN%" build/server/index.js 1>> "logs\server.log" 2>&1"

echo.
echo 启动中，稍后会自动打开画布与豆包账号管理页。
echo.
echo 豆包账号额度不足时，在「画布 → 设置 → 媒体模型 → 豆包账号」里
echo 点「绑定新账号（扫码）」即可；绑完回画布直接生成，会自动选用还有额度的账号。
echo.
timeout /t 8 >nul
start "" "http://localhost:3000/#/workspace"
start "" "http://127.0.0.1:18077/"
