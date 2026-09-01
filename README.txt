ECHO Harness（Execution · Context · Harness · Orchestration）
仓库：https://github.com/C715543139/ECHOCodingHarness

一个从零实现、Windows 优先的轻量本地 coding agent。核心使用 TypeScript、Node.js 22、pnpm 11.24.0、Vitest 与 tsup；通过 OpenAI-compatible Provider 接入模型，自行维护 Turn/Step 循环、上下文投影、六个工作区工具、安全策略、终止判断和脱敏 JSONL 事件。

安装：
corepack enable
corepack prepare pnpm@11.24.0 --activate
pnpm install --frozen-lockfile
pnpm build

使用 node .\dist\cli.js config 将 Provider URL、模型和默认安全模式写入 dist/config/echo.config.json；仅 API Key 通过 ECHO_API_KEY 注入，不写入配置文件。运行：
node .\dist\cli.js run "修复失败测试" --workspace . --safety-mode balanced --non-interactive --no-color

亮点：显式自主循环；工具成功与任务完成分离；CLI 与本地 Web 控制台共用应用服务；工作区隔离、审批、Full Access 明确确认、硬拒绝、超时和脱敏集中执行；Agent 可在 Full Access 下创建、自测、检查并热加载当前工作区扩展，跨 Session 复用但不跨工作区；Windows PowerShell、Unicode 路径和进程树清理有测试；Fake Provider Eval、Playwright、覆盖率、恶意扫描样本和 Windows CI 形成质量证据。

演示：P3 使用公开合成的 fixtures/p3-pdf-demo。先运行 pnpm p3:demo:reset 与 pnpm p3:demo:baseline，再只向 Agent 描述能力缺口和持久复用目标，由它自主命名、创建、自测并热加载工作区扩展，读取 PDF 要求、修复失败代码并复测；精确的新 Session 可直接复用扩展，另一工作区不可见。验收拒绝安装前用一次性命令绕过能力缺口；pnpm p3:demo:verify 通过受保护输入哈希和 Harness 外独立测试给出完成证据。

限制：本项目和扩展 Worker 都不是操作系统沙箱；Full Access 命令仍拥有当前用户权限；不含全局插件市场、远程扩展、OCR、MCP、多智能体或完整回滚；模型服务会接收上下文投影选取的代码片段；自动扫描不能替代提交前人工双盲复核。
