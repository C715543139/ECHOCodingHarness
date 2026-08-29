# ADR-0002：P1 配置来源、artifact-root 与模型目录

> 状态：Accepted
>
> 日期：2026-08-29
>
> 接受日期：2026-08-29
>
> 决策者：项目维护者
>
> 取代：P0 [contracts.md](../contracts.md) 第 10 节中的配置来源与优先级，自 P1-2A 运行时合入起生效

## 1. 背景

P0 按 `CLI > 环境变量 > 项目配置 > 用户配置 > 内置默认值` 合并配置，并支持 `ECHO_BASE_URL`、`ECHO_MODEL`、`ECHO_SAFETY_MODE` 以及工作区/`APPDATA` 下的 `echo.config.json` 与 `.echo-config.json`。该模型便于单次 `run` 演示，但不适合固定产物、从任意工作目录启动，也不适合与未来 WebUI 共享同一份非秘密配置。

P1 需要在写 Chat 与配置向导之前冻结唯一持久配置位置、秘密隔离、模型目录和取代时点。项目尚未公开发布，因此不建立多版本迁移层。

## 2. 决策

### 2.1 唯一持久配置

非秘密配置只持久化到：

```text
<artifact-root>/config/echo.config.json
```

`artifact-root` 必须根据 CLI 入口模块或可执行文件的解析位置得到，不得使用 `process.cwd()` 或当前工作区根目录寻找配置。开发、测试和 `tsx` 入口通过显式依赖注入提供产物根，避免绑定个人路径。

从非产物工作目录启动时，仍读取上述固定文件。

### 2.2 优先级与秘密

P1 普通配置优先级只保留：

```text
CLI 显式参数 > echo.config.json
```

省略字段的数值缺省（例如 `safetyMode: balanced`）不是配置来源，不得写入来源诊断，也不得进入 `P1ConfigSource`。`cli | session | config` 只用于会话内当前模型与安全模式。

`ECHO_API_KEY` 是唯一正式支持的秘密环境变量，不参与普通配置合并，也不得写入配置文件、事件、终端或工具子进程。配置诊断只报告 Key 为 `configured` 或 `missing`。

以下 P0 来源在 P1 运行时中移除，且不提供读取兼容：

- 项目配置与用户配置目录扫描；
- `echo.config.json` / `.echo-config.json` 作为工作区或家目录发现文件；
- `ECHO_BASE_URL`、`ECHO_MODEL`、`ECHO_SAFETY_MODE`。

### 2.3 配置结构

配置文件是一个 JSON 对象。允许的键为 `baseUrl`、`model`、`modelCatalog`、`safetyMode`，以及 P0 已有的非敏感限制字段：`maxSteps`、`timeoutMs`、`maxOutputChars`、`requestTimeoutMs`、`context`。

`modelCatalog` 只有两种形态：

- `{ "source": "discover" }`：不持久化完整发现列表，只持久化默认 `model`；
- `{ "source": "manual", "models": ["id-a", "id-b"] }`：至少含一个唯一、非空模型 ID，且默认 `model` 必须在列表中。

未知键、`apiKey`、授权头、URL 内嵌凭据一律产生配置错误并拒绝加载，不得静默忽略。缺少配置文件时，`run` 与 `chat` 使用退出码 `2`，并提示执行 `echo-harness config`；不得自动创建含真实 Provider 信息的文件。

### 2.4 模型目录

自动发现只允许当前 OpenAI-compatible 客户端请求 `GET {baseUrl}/models`，并只使用响应中的模型 ID。列表缓存在当前进程内。`run` 不主动发现；`chat` 仅在 `/model` 需要候选项时通过可注入的模型目录端口延迟发现，不重复实现第二套发现与缓存。发现失败不得阻止已配置模型的实际调用。P1-2B 实现该运行时：`ProcessModelCatalog` 与 `ModelCatalogClient` 独立于 `ModelProvider.stream`，刷新失败时保留旧缓存，错误必须脱敏。

### 2.5 取代时点与兼容边界

| 阶段 | 有效事实 |
| --- | --- |
| P1-0 合入后、P1-2A 之前 | 本文与 [contracts.md](../contracts.md) 1.1 是 P1 的冻结契约。当时 `echo-harness run` 仍执行 P0 合并规则。 |
| P1-2A 合入后 | 运行时执行本文与契约 1.1。加载器只读取 `<artifact-root>/config/echo.config.json`；P0 来源测试改为断言这些来源已被忽略，且不得继续读取已移除来源。 |
| P1-2B 合入后 | 运行时执行模型目录发现与进程内缓存。`run` 仍不调用 `/models`；Chat `/model` 与 `/model refresh` 是唯一延迟发现入口。 |
| 已有 P0 本地文件 | 不迁移工作区或用户目录中的旧配置文件。操作者使用 `echo-harness config` 重新写入产物配置。 |

P1-0 只冻结契约、ADR 与测试矩阵。P1-2A 实现 `loadConfig`、artifact-root 解析、配置文件校验与 `echo-harness config`。P1-2B 实现 `GET /models` 发现、进程内缓存与失败不阻断。P1-1B 已实现 Chat 输入解析、Slash 与 `--resume`，并通过目录端口消费 P1-2B 的发现实现。

## 3. 选择理由

固定产物根目录让演示和“从任意 cwd 启动”行为可预测，也避免把个人工作区路径写进配置查找逻辑。移除多层环境变量和双文件名发现，是因为当前没有外部用户需要平滑迁移，复杂兼容层会让 Chat、WebUI 和测试矩阵同时分叉。密钥继续只走环境变量，以保持事件与配置文件可分享。

## 4. 被考虑但未采用的方案

- 保留 `ECHO_BASE_URL` / `ECHO_MODEL` 作为隐藏兼容层：会让“配置来源”诊断和测试矩阵永久分叉。
- 按 `process.cwd()` 或工作区查找配置：与“非产物目录启动”验收冲突。
- 多 Provider Profile 与 `config get/set`：超出 P1 范围。
- 把 API Key 写入配置文件：违反 P0 已接受的秘密边界。

## 5. 后果

- P1-2A 必须同时改加载器、错误码、文档和测试；不能只改运行时。
- 只读安装目录与多用户系统不是本决策的目标环境。
- `pnpm dev` 必须注入 artifact-root，否则会误写 `src/config/`。

## 6. 重新评估触发条件

- 需要公开分发后的配置迁移；
- 需要用户级或工作区级覆盖；
- 需要第二种 Provider 或 Profile；
- 产物目录不可写，必须改用 XDG/`APPDATA`。
