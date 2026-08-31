# ADR-0011：工作区级扩展、Worker 与持久生命周期

> 状态：Accepted for P3 implementation
>
> 日期：2026-08-31

## 背景

ECHO 的内置工具固定且有界。P3 希望演示 Agent 遇到 PDF 等能力缺口时，可以自行创建、测试、安装
并热加载一个工具，而且同一代码仓库中的后续 Session 可以复用。将扩展安装到全局目录会使不同工作区
共享未知状态，增加版本、隐私和清理问题，因此不采用全局 Registry。

## 决策

扩展是当前工作区的持久能力，安装根目录固定为 `<workspace>/.echo/extensions`，只能使用以下布局：

```text
<workspace>/.echo/
├─ sessions/
├─ extension-staging/
│  └─ <extension-id>/
└─ extensions/
   ├─ catalog.json
   ├─ .trash/
   └─ <extension-id>/
      └─ <sha256>/
         ├─ extension.json
         ├─ index.mjs
         └─ extension.test.mjs
```

`.echo/` 继续默认不进入 Git。Provider 配置仍位于 artifact-root 的 `config/echo.config.json`；工作区
扩展不是安装目录配置，也不跨工作区同步。

### Manifest v1

`extension.json` 使用严格未知键拒绝 Schema：

```ts
interface ExtensionManifest {
  readonly schemaVersion: 1;
  readonly id: string;          // lower-case kebab-case
  readonly version: string;     // x.y.z
  readonly entry: string;       // extension-relative .mjs
  readonly selfTest: string;    // extension-relative .test.mjs
  readonly tools: readonly {
    readonly name: string;      // lower_snake_case
    readonly description: string;
    readonly inputSchema: Readonly<Record<string, unknown>>;
  }[];
}
```

ID、路径、描述、工具数量和 Schema 大小均使用实现常量设上限；入口与自测不得逃逸扩展目录。工具名
不能覆盖内置工具、`extension_` 管理命名空间或当前工作区其他扩展。首版不声明依赖图；扩展可以使用
Node 内置模块或当前工作区已经安装的依赖。

安装内容以规范化文件集合的 SHA-256 标识为 `sha256:<hex>`。同 ID/同哈希安装幂等；同 ID/不同哈希
是原子替换，首版不保留可选版本和回滚 UI。

### Catalog v1

`catalog.json` 只记录当前工作区：

```ts
interface ExtensionCatalog {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly extensions: readonly {
    readonly id: string;
    readonly version: string;
    readonly contentHash: string;
    readonly state: 'enabled' | 'disabled' | 'quarantined';
    readonly tools: readonly string[];
    readonly installedAt: string;
    readonly quarantineReason?: string;
    readonly cleanupPending?: boolean;
  }[];
}
```

Catalog 使用同目录临时文件、flush、原子替换并递增 revision；无法解析、未知版本、哈希/目录不一致
或恢复不确定时失败关闭，不扫描目录猜测状态。

### Worker 协议

每个已加载扩展运行在独立 Node Worker。Host 请求只有 `initialize`、`execute`、`cancel`、`shutdown`，
Worker 响应只有 `ready`、`result`、`failure`、`protocol_error`；每条消息携带有界 ID 并由 Host 校验。
Worker 隔离用于超时、取消、崩溃恢复和可靠卸载，不构成 OS 沙箱。

入口导出与 Manifest 工具一一对应的 handlers。Host 提供当前工作区、调用 ID 和有界 limits，但不传递
`ECHO_API_KEY` 或无关环境凭据。返回值必须可结构化克隆并符合 `ToolExecution`；超限输出由 Host
截断。初始化失败、Worker 崩溃或协议违规使扩展持久化为 `quarantined` 并注销全部工具；一次普通业务
失败只返回 `tool.failed`，不自动隔离或删除代码。

安装或启用成功后，新增工具从下一次模型请求开始出现在定义列表中。模型不能在一条响应里安装并调用
此前未知的工具。

### 生命周期

```text
staging --check--> checked staging --install--> enabled
enabled --disable--> disabled --enable--> enabled
enabled/disabled --worker fault--> quarantined --enable with recheck--> enabled
installed --uninstall--> absent
```

`extension_disable` 和 `extension_uninstall` 遇到活动调用返回稳定 `extension_busy`，要求先停止 Turn。
卸载先注销工具并停止 Worker，再原子移除 Catalog，随后把目录移动到 `.trash` 并尝试删除安装版本与
同 ID staging。物理删除失败时返回 `deactivated` 与 `cleanupPending=true`；不得声称完全删除。

## 被否决方案

- 安装到构建产物或用户全局目录：跨工作区状态与隐私边界不清；
- 在主进程直接 `import()`：崩溃、取消、缓存和卸载不可控；
- 单工具删除：一个扩展可拥有多个共享实现的工具，生命周期所有权会破裂；
- 一次异常自动卸载：会丢失可诊断代码，也会把普通输入错误误判为扩展损坏；
- 首版实现市场、远程安装、签名、自动更新、依赖图、插件间通信或插件 UI：投入高且无助于两分钟核心
  展示。
