@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动资产管家...
echo 浏览器将打开 http://127.0.0.1:5000 （若未自动打开请手动访问）
start "" http://127.0.0.1:5000
.venv\Scripts\python.exe app.py
pause
