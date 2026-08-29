# ADR-0005：恢复产物根持久配置

> 状态：Accepted
>
> 日期：2026-08-29
>
> 接受日期：2026-08-29
>
> 决策者：项目维护者
>
> 取代：[ADR-0004](./0004-workspace-echo-config.md)
>
> 恢复：[ADR-0002](./0002-p1-config-artifact-root.md) 第 2.1 节

## 1. 背景

ADR-0004 把非秘密配置改到工作区：

```text
<workspace>/.echo/config/echo.config.json
```

该改动来自从 `dist/` 启动时看到 `config/` 与 `.echo/sessions/` 分属两套目录的误判。会话按工作区隔离是正确的；Provider、默认模型和安全模式是 CLI 安装/构建产物的设置，不应跟随 `--workspace`。

ADR-0002 的其余规则仍然有效：CLI 显式参数优先于配置文件、`ECHO_API_KEY` 隔离、未知键失败、不读取 `ECHO_BASE_URL` / 工作区根 `echo.config.json`、缺少文件时退出码 2 且不自动创建。

## 2. 决策

唯一持久配置文件恢复为：

```text
<artifact-root>/config/echo.config.json
```

`artifact-root` 根据 CLI 入口模块或可执行文件的解析位置得到，不得使用 `process.cwd()` 或当前工作区根目录寻找配置。开发、测试和 `tsx` 入口继续通过显式依赖注入提供产物根。

加载器不得读取：

- 工作区 `.echo/config/echo.config.json`（ADR-0004 落点）；
- 工作区根目录的 `echo.config.json` 或 `.echo-config.json`；
- `ECHO_BASE_URL`、`ECHO_MODEL`、`ECHO_SAFETY_MODE`。

不迁移工作区 `.echo/config` 文件。操作者对 CLI 产物重新运行 `echo-harness config`。

`.echo/sessions/` 仍在工作区下，与配置分属不同根。

## 3. 选择理由

从任意 cwd 或任意 `--workspace` 启动时，同一份 CLI 应使用同一份 Provider 配置。把配置绑到工作区，会让每个仓库各写一份，也让从 `dist/` 启动看起来像“配置跟仓库走”，而这只是产物目录与工作区碰巧相同造成的错觉。

## 4. 被考虑但未采用的方案

- 保留 ADR-0004 的工作区 `.echo/config`：配置会随仓库变化，违背安装作用域。
- 同时读取产物根与工作区文件：多层发现会让来源诊断永久分叉。
- 按 `process.cwd()` 查找：与非产物目录启动验收冲突。

## 5. 后果

- `pnpm smoke:artifact` 再次断言产物根 `config/` 生效，并忽略 cwd / 工作区 `.echo/config` 诱饵。
- `pnpm dev` 必须注入 artifact-root，否则会误写 `src/config/`。
- Chat 审批提示、CR/CRLF 规范化、拒绝只渲染一次 `DENIED`、组间/Slash/状态栏间距与 SESSION 短 ID 恢复不在本 ADR 范围内，不得随配置返工回退。

## 6. 重新评估触发条件

- 需要按工作区隔离 Provider 配置；
- 产物目录不可写，必须改用 XDG/`APPDATA`；
- 需要公开分发后的配置迁移。
