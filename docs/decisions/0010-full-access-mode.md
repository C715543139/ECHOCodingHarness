# ADR-0010：显式确认的 Full Access 模式

> 状态：Accepted for P3 implementation
>
> 日期：2026-08-31

## 背景

P0–P2 的 `safe`、`balanced`、`auto` 适合日常受控开发，但它们会拒绝工作区外路径、凭据访问、
提权、编码执行和广泛破坏性命令，并对网络、依赖、Git、删除及未分类命令请求审批。P3 的目标之一
是让 Agent 在用户充分知情时创建、测试、安装和复用工作区扩展；如果仍逐次审批，真实编程任务会被
大量确认打断。

## 决策

P3 将有效安全模式扩展为：

```text
safe | balanced | auto | full-access
```

`safe`、`balanced`、`auto` 的既有行为不变。`full-access` 是用户授予当前 Session 的高风险运行
权限，不是模型能力，也不是默认升级路径。

### 授权门

- 模型不能通过提示、工具调用或模型文本创建授权；
- 新 Session 无论从配置、CLI 还是继承候选得到 `full-access`，都必须先由人类确认，确认前不得把该
  模式写成 Session 的有效状态；
- CLI 交互使用完整风险提示；非交互 `run` 只有同时提供 `--safety-mode full-access` 与
  `--allow-full-access` 才能进入；
- Web 创建 Session 或更新运行时必须提交 `fullAccessConfirmation: { acceptedRisk: true }`，且页面
  必须先显示确认对话框；
- 已确认 Session 的持久 `safetyMode=full-access` 本身就是授权事实，恢复同一 Session 时不重复确认；
- 切换到其他模式立即撤销授权；同一 Session 再次进入 `full-access` 必须重新确认；
- 进入或离开模式只在没有活动 Turn 时进行，沿用 `safety.changed`，不增加 Session 事件版本。

### 权限语义

确认后，Central Safety Policy 对所有已注册工具返回 allow，不生成逐操作审批。因此
`run_command` 可以执行网络访问、依赖安装、Git 修改、删除、工作区外路径及其他高风险 PowerShell
命令。既有文件工具继续只接受工作区相对路径；需要更广文件访问时使用 `run_command`。这保留了内置
工具的稳定输入契约，同时仍给予 Agent 实际的完全访问能力。

Full Access 不关闭以下可靠性边界：

- JSON Schema 与输入正规化；
- 工具和 Provider 的超时、取消、输出上限及进程树清理；
- Session 事件、Trace、Policy Explain 与敏感信息脱敏；
- `ECHO_API_KEY` 和无关凭据不传给命令或扩展子进程；
- 扩展 Worker 的协议验证及故障隔离。

Full Access 不是 OS 沙箱，也不承诺操作可恢复。警告必须说明它可能修改或删除文件、安装软件、访问
网络、操作 Git 以及执行模型生成的任意命令。

### 动态扩展

Agent 的扩展生命周期工具只在已确认的 `full-access` 中注册。切换到其他模式后，当前工作区动态工具
在下一次模型请求边界前从 Registry 注销，但安装文件与 Catalog 状态保留。人类通过本地 Web 设置页
进行列举、禁用、启用或卸载不依赖 Session 的 Full Access，因为该操作本身是直接 UI 管理动作而非
模型授权。

## 被否决方案

- 把 `auto` 扩展成完全访问：会悄然改变既有安全语义；
- 每个扩展操作继续弹审批：与明确授权后的连续自主执行目标冲突；
- 让模型调用切换模式工具：破坏授权主体边界；
- 进程重启后要求恢复 Session 再次确认：会让同一持久 Session 的有效状态产生歧义；
- 把 Full Access 宣传成沙箱：与 Windows PowerShell 的实际能力不符。

## 后果

P3-A1 负责把本 ADR 的目标联合迁移到现有运行时类型、配置、CLI 和 Web DTO。P3-A0 只冻结目标
契约；在 A1 完成前，P0–P2 的 `SafetyMode` 仍是已交付运行时联合。
