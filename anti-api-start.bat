@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo.
echo   █████╗ ███╗   ██╗████████╗██╗         █████╗ ██████╗ ██╗
echo  ██╔══██╗████╗  ██║╚══██╔══╝██║        ██╔══██╗██╔══██╗██║
echo  ███████║██╔██╗ ██║   ██║   ██║ █████╗ ███████║██████╔╝██║
echo  ██╔══██║██║╚██╗██║   ██║   ██║ ╚════╝ ██╔══██║██╔═══╝ ██║
echo  ██║  ██║██║ ╚████║   ██║   ██║        ██║  ██║██║     ██║
echo  ╚═╝  ╚═╝╚═╝  ╚═══╝   ╚═╝   ╚═╝        ╚═╝  ╚═╝╚═╝     ╚═╝
echo.
echo ================================
echo.

set PORT=8964

echo 端口: %PORT%

:: 检查端口占用
netstat -ano | findstr :%PORT% >nul 2>&1
if %errorlevel%==0 (
    echo 端口被占用.
    for /f "tokens=5" %%a in ('netstat -ano ^| findstr :%PORT%') do (
        taskkill /PID %%a /F >nul 2>&1
    )
    echo 端口已释放.
)

:: 加载 bun 路径（如果已安装）
if exist "%USERPROFILE%\.bun\bin\bun.exe" (
    set "PATH=%USERPROFILE%\.bun\bin;%PATH%"
)

:: 检查 bun
where bun >nul 2>&1
if %errorlevel% neq 0 (
    echo 安装 Bun...
    powershell -Command "irm bun.sh/install.ps1 | iex"
    if %errorlevel% neq 0 (
        echo [错误] Bun 安装失败
        goto :error
    )
    :: 重新加载路径
    set "PATH=%USERPROFILE%\.bun\bin;%PATH%"
)

:: 再次检查 bun
where bun >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 找不到 Bun，请手动安装: https://bun.sh
    goto :error
)

:: 安装依赖
if not exist "node_modules" (
    echo 安装依赖...
    bun install --silent
    if %errorlevel% neq 0 (
        echo [错误] 依赖安装失败
        goto :error
    )
)

echo.
echo ================================
echo.

:: 启动服务器
bun run src/main.ts start
if %errorlevel% neq 0 (
    echo.
    echo [错误] 服务器异常退出
    goto :error
)

goto :end

:error
echo.
echo 按任意键退出...
pause >nul
exit /b 1

:end
pause
