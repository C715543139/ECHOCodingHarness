ECHO Harness（Execution · Context · Harness · Orchestration）
仓库：https://github.com/C715543139/ECHOCodingHarness

一个从零实现、Windows 优先的轻量本地 coding agent。核心使用 TypeScript、Node.js 22、pnpm 11.24.0、Vitest 与 tsup；通过 OpenAI-compatible Provider 接入模型，自行维护 Turn/Step 循环、上下文投影、六个工作区工具、安全策略、终止判断和脱敏 JSONL 事件。

安装：
corepack enable
corepack prepare pnpm@11.24.0 --activate
pnpm install --frozen-lockfile
pnpm build

使用：
1. 配置 Provider：
node .\dist\cli.js config

该向导会将 Provider URL、模型目录、默认模型和安全模式写入 dist/config/echo.config.json。API Key 不会写入配置文件，请在 PowerShell 中通过环境变量提供：
$env:ECHO_API_KEY = '<your-api-key>'

2. 单次运行 run：执行一个目标，完成后退出。--workspace 指定 Agent 可以操作的工作区。
node .\dist\cli.js run "检查项目并修复失败测试" --workspace .\fixtures\demo --safety-mode balanced

3. 交互会话 chat：在同一 Session 中连续对话，也可使用 /model、/safety、/status 和 /help。
node .\dist\cli.js chat --workspace .\fixtures\demo
node .\dist\cli.js chat --resume <session-id> --workspace .\fixtures\demo

4. 本地 Web 控制台 web：为指定工作区启动仅监听 127.0.0.1 的图形界面，并默认打开浏览器。
node .\dist\cli.js web --workspace .\fixtures\p3-pdf-demo
node .\dist\cli.js web --workspace .\fixtures\p3-pdf-demo --no-open

亮点：
显式自主循环；工具成功与任务完成分离；CLI 与本地 Web 控制台共用应用服务；工作区隔离、审批、Full Access 明确确认、硬拒绝、超时和脱敏集中执行；Agent 可在 Full Access 下创建、自测、检查并热加载当前工作区扩展，跨 Session 复用但不跨工作区；Windows PowerShell、Unicode 路径和进程树清理有测试；Fake Provider Eval、Playwright、覆盖率、恶意扫描样本和 Windows CI 形成质量证据。
