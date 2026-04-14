@echo off
rem paper-daily.bat — 每周论文推送脚本（Windows）
rem 建议配合 Windows 任务计划程序：每周一早上 8:00 运行

chcp 65001 >nul
setlocal

set SCRIPT_DIR=%~dp0
set PROJECT_DIR=%SCRIPT_DIR%..
set LOGS_DIR=%PROJECT_DIR%\logs
for /f "tokens=1-3 delims=-" %%a in ("%date:~0,10%") do (
    set DATE=%%a-%%b-%%c
)

if "%DATE%"=="" set DATE=%date:~0,4%-%date:~5,2%-%date:~8,2%

echo ========== 🤖 PaperWeekly 启动 | %date% %time% ==========

rem Step 1: 运行主 Agent（采集 + 分析 + 发送）
echo [1/2] 📥 采集并发送周报...
node "%PROJECT_DIR%\paper-daily-agent.js" all >> "%LOGS_DIR%\weekly_%DATE%.log" 2>&1
if %errorlevel% neq 0 (
  echo ❌ 执行失败，请查看日志: %LOGS_DIR%\weekly_%DATE%.log
  exit /b 1
)

echo [2/2] ✅ 周报流程已完成
echo ========== ✅ PaperWeekly 完成 | %date% %time% ==========
