# P2 WebUI 临时示意图

> 状态：Temporary visual aid（P2 完成后必须删除）
>
> 最后更新：2026-08-30

本目录中的三张图只是 P2 实现前的桌面信息架构 demo，用于确认侧栏、`对话 / 轨迹`、输入区和
Provider 模态的相对位置。它们是非最终视觉稿，不是视觉规范、像素级实现稿或验收基线，并含有与
契约不一致的示意文案。

实现权威始终是 [web-ui.md](../web-ui.md) 与 [web-api.md](../web-api.md)。

## 文件

| 图 | 场景 |
| --- | --- |
| [echo-webui-chat.png](./p2-webui-demo/echo-webui-chat.png) | 两栏 Chat、活动 Turn 提示条 |
| [echo-webui-trace.png](./p2-webui-demo/echo-webui-trace.png) | 三栏 Trace 与按需 Inspector |
| [echo-webui-provider-settings.png](./p2-webui-demo/echo-webui-provider-settings.png) | 空闲 Session 上的 Provider 设置模态 |

## 图与契约不一致之处

实现不得照抄图中的这些细节：

- 安全模式必须是 `safe` / `balanced` / `auto`，不是 `Workspace Write`；
- 默认上下文上限是 256,000 近似 token（另预留 16,000），不是图中的 `128k`；
- 顶栏在 Session 名称后常驻“绿点 + 已连接”或“红点 + 未连接”；图中遗漏了该状态；
- 运行时发送必须禁用；停止只在提示条。图中蓝色可点发送无效；
- 同一画面只表达一种进程状态。图中 Trace 出现 Turn 已完成却仍挂“正在运行”，无效；
- Session 行必须有文字状态，不加状态图标。图中可能只有高亮；
- Inspector 必须能投影元数据、参数、结果、限制和关联。图上可能只画出前三项；
- Chat 工具行不得使用 `Verified`；该标记只属于验证记录或 Inspector；
- Provider 发现结果是只读列表，不使用单选按钮；只有默认模型选择可写；
- Provider 不展示独立的“可用”状态；发现失败使用字段级错误；
- 消息复制只是可选增强，图中的消息刷新操作不进入 P2。

## P2 完成后必须删除

P2 最终验收通过、实现状态从「尚未实现」改为已交付后，必须在同一收尾提交中删除：

- [p2-webui-demo.md](./p2-webui-demo.md)
- [p2-webui-demo/](./p2-webui-demo/) 下全部 PNG

并同时去掉 [web-ui.md](../web-ui.md)、[p2-webui.md](./p2-webui.md)、
[p2-acceptance-matrix.md](./p2-acceptance-matrix.md) 与 [AGENTS.md](../../AGENTS.md) 中对本目录的
引用。不得把这些 demo 图留作产品截图、文档插图或验收证据。
