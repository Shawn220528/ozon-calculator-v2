@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title Ozon RFBS Calculator - 本地启动

echo.
echo ========================================
echo   Ozon RFBS Calculator 本地启动检查
echo ========================================
echo.

cd /d "%~dp0"
echo [信息] 工作目录: %cd%

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js: https://nodejs.org/
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('node -v') do set NODE_VERSION=%%i
echo [✓] Node.js: !NODE_VERSION!

where npm >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未检测到 npm
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('npm -v') do set NPM_VERSION=%%i
echo [✓] npm: !NPM_VERSION!

if not exist "package.json" (
    echo [错误] 当前目录不是项目根目录
    pause
    exit /b 1
)

if not exist "node_modules\" (
    echo [信息] 首次运行，正在安装依赖...
    call npm install
    if %errorlevel% neq 0 (
        echo [错误] 依赖安装失败
        pause
        exit /b 1
    )
)

if not exist ".env.local" (
    echo [提示] 未发现 .env.local；当前项目可继续运行，但外部配置会使用默认值。
) else (
    echo [✓] 已发现 .env.local
)

call npm test
if %errorlevel% neq 0 (
    echo [错误] 解析器自检失败，请先修复后再启动。
    pause
    exit /b 1
)

set PORT=3000
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3000 ^| findstr LISTENING') do (
    set EXISTING_PID=%%a
)

if defined EXISTING_PID (
    echo [提示] 端口 3000 已被占用，PID: !EXISTING_PID!
    echo [信息] 将复用现有服务: http://localhost:3000
    start "" http://localhost:3000
    echo.
    echo 如需重启，请先运行 stop-local.bat
    pause
    exit /b 0
)

echo.
echo ========================================
echo   启动开发服务器
echo   访问地址: http://localhost:3000
echo   按 Ctrl+C 可停止服务
echo ========================================
echo.

start "" cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:3000"
call npm run dev -- --port 3000

pause
