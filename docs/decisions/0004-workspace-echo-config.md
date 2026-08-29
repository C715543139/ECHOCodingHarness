# ADR-0004：工作区 `.echo/config` 持久配置

> 状态：Accepted
>
> 日期：2026-08-29
>
> 接受日期：2026-08-29
>
> 决策者：项目维护者
>
> 部分取代：[ADR-0002](./0002-p1-config-artifact-root.md) 第 2.1 节的持久文件落点

## 1. 背景

ADR-0002 把非秘密配置固定在 CLI 产物根：

```text
<artifact-root>/config/echo.config.json
```

会话事件则写在工作区 `.echo/sessions/`。从工作区或 `dist/` 启动时会出现顶层 `config/` 与 `.echo/sessions/` 分属两套目录的结构。编码代理的 Provider、模型和安全模式应按仓库隔离，而不是跟可执行文件安装位置绑定。

ADR-0002 仍有效的部分：CLI 显式参数优先于配置文件、`ECHO_API_KEY` 隔离、未知键失败、不读取 `ECHO_BASE_URL` / 工作区根目录的 `echo.config.json`、缺少文件时退出码 2 且不自动创建。

## 2. 决策

唯一持久配置文件为：

```text
<workspace>/.echo/config/echo.config.json
```

它与会话存储同属工作区 `.echo/`：

```text
<workspace>/.echo/config/echo.config.json
<workspace>/.echo/sessions/<session-id>.jsonl
```

`workspace` 与 `run` / `chat` 相同：CLI `--workspace`，否则为启动时的当前目录。`echo-harness config` 接受同样的 `--workspace`，写入该工作区的 `.echo/config/`。

加载器不得读取：

- CLI 产物目录下的 `config/echo.config.json`（ADR-0002 旧落点）；
- 工作区根目录的 `echo.config.json` 或 `.echo-config.json`；
- `ECHO_BASE_URL`、`ECHO_MODEL`、`ECHO_SAFETY_MODE`。

不迁移旧的产物根配置文件。操作者在目标工作区重新运行 `echo-harness config`。

## 3. 选择理由

配置与会话都是工作区本地状态，放在同一 `.echo/` 树下可预测、可 gitignore，也避免在仓库根或 `dist/` 旁留下单独的 `config/`。从任意 cwd 启动时，配置跟随 `--workspace`，而不是跟随 `cli.js` 所在目录。

## 4. 被考虑但未采用的方案

- 继续使用产物根 `config/`：与 `.echo/sessions` 不一致，且多仓库共享一份 Provider 配置。
- 同时读取产物根与工作区文件：会恢复多层发现，来源诊断永久分叉。
- 把配置文件放到工作区根而不是 `.echo/config/`：会在仓库根留下非忽略的配置目录。

## 5. 后果

- `.echo/` 已由 Git 忽略，配置与会话一样默认不入库。
- `pnpm smoke:artifact` 改为断言工作区 `.echo/config` 生效，并忽略 cwd 诱饵与产物根旧路径。
- 开发入口不再需要注入 artifact-root 来避免误写 `src/config/`。

## 6. 重新评估触发条件

- 需要跨工作区共享同一份 Provider 配置；
- 需要把非秘密配置纳入版本控制；
- 产物目录或工作区不可写，必须改用 XDG/`APPDATA`。
