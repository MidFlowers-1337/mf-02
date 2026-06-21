@echo off
chcp 65001 >nul
title 自习室工位预约系统

echo ============================================
echo 自习室工位预约系统 - 启动脚本
echo ============================================
echo.

echo [1/5] 检查 Node.js 环境...
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js
    pause
    exit /b 1
)
echo Node.js 版本:
node --version

echo.
echo [2/5] 检查 npm 环境...
npm --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未检测到 npm
    pause
    exit /b 1
)
echo npm 版本:
npm --version

echo.
echo [3/5] 安装项目依赖...
if not exist "node_modules" (
    call npm install
    if %errorlevel% neq 0 (
        echo [错误] 依赖安装失败
        pause
        exit /b 1
    )
) else (
    echo 依赖已存在，跳过安装
)

echo.
echo [4/5] 运行单元测试...
call npm test
if %errorlevel% neq 0 (
    echo [警告] 部分测试未通过，但不影响启动
    echo.
)

echo.
echo ============================================
echo 准备启动服务器，端口 3000
echo ============================================
echo.
echo ============ 验证流程说明 =================
echo 1. 打开浏览器访问 http://localhost:3000 （学生端）
echo    注册账号 -> 登录 -> 选日期 -> 选时段 -> 选工位 -> 确认预约
echo    到点后点击「签到」-> 使用完点击「结束使用」
echo.
echo 2. 模拟超时释放：
echo    预约一个当前小时的工位（比如现在 14:xx，约 14:00 的）
echo    不要签到，等 15 分钟后（或等定时任务轮询）
echo    刷新页面看预约状态是否变成「爽约」
echo    同时查看控制台是否打印 [scheduler] 已释放... 的日志
echo.
echo 3. 测试爽约禁约：
echo    故意爽约 3 次（每次都预约不签到，等超时）
echo    第 4 次预约时会提示「您因爽约3次已被禁约」
echo    7 天后自动解除
echo.
echo 4. 老板后台 http://localhost:3000/admin.html
echo    账号 admin / admin123
echo    可以看工位利用率、热门时段、用户爽约记录
echo.
echo 5. 测试冲突预约：
echo    用账号 A 约某时段某工位，再用账号 B 同时段约同一工位
echo    应该提示「该工位此时段已被预约」
echo.
echo 6. 测试同时段多工位：
echo    同一账号约了 A01 10:00，再约 A02 10:00
echo    应该提示「您同时段已预约了其他工位」
echo ============================================
echo.
echo 按任意键启动服务器...
pause >nul

echo.
echo [5/5] 启动服务器...
echo.
call npm start
