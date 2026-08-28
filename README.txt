ECHO Harness（Execution · Context · Harness · Orchestration）
仓库：https://github.com/C715543139/ECHOCodingHarness

一个从零实现、Windows 优先的轻量本地 coding agent。核心使用 TypeScript、Node.js 22、pnpm 11.24.0、Vitest 与 tsup；通过 OpenAI-compatible Provider 接入模型，自行维护 Turn/Step 循环、上下文投影、六个工作区工具、安全策略、终止判断和脱敏 JSONL 事件。

安装：
corepack enable
corepack prepare pnpm@11.24.0 --activate
pnpm install --frozen-lockfile
pnpm build

配置环境变量 ECHO_BASE_URL、ECHO_API_KEY、ECHO_MODEL；API Key 不写入配置文件。运行：
node .\dist\cli.js run "修复失败测试" --workspace . --safety-mode balanced --non-interactive --no-color

亮点：显式自主循环；工具成功与任务完成分离；工作区隔离、审批、硬拒绝、超时和脱敏集中执行；Windows PowerShell、Unicode 路径和进程树清理有测试；Fake Provider Eval、覆盖率、恶意扫描样本和 Windows CI 形成质量证据。

演示：先执行 node scripts/demo-reset.mjs，再用 fixtures/demo/prompt.txt 运行固定失败测试项目，连续展示检查、失败测试、定位、apply_patch、复测和完成。

限制：本项目不是操作系统沙箱；已批准的命令仍拥有当前用户权限；不含 Web UI、MCP、多智能体或完整回滚；模型服务会接收上下文投影选取的代码片段；自动扫描不能替代提交前人工双盲复核。
