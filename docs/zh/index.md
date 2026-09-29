# noeta-agent 文档

单用户、本地优先的 agent 工作台：一个进程、你自己的目录、没有账号体系。产品是什么见
[README](../../README.md)；这一页是其余文档的地图。

> 英文树是权威版本，中文树是它的镜像。两边不一致时以
> [`docs/`](../index.md) 为准。

| 层次 | 文档 | 用途 |
| --- | --- | --- |
| 教程 | [快速开始](tutorials/quickstart.md) | 启动、建项目、看一轮对话被重放出来。 |
| How-to | [使用工作台](how-to/use-the-workbench.md) | 项目、会话、轮次控制、侧边面板。 |
| How-to | [接入网关](how-to/configure-provider.md) | 换成真实模型。 |
| 参考 | [产品参考](reference/noeta-agent.md) | 启动模式、架构、sandbox 层。 |
| 参考 | [HTTP API](reference/http-api.md) | 全部路由、SSE 流、错误码。 |
| 参考 | [配置](reference/configuration.md) | 每一个 `.env` key 及默认值。 |
| 参考 | [wire contract](../reference/wire-contract.md) | **规范性文档（英文）**：冻结的 UI 事件词汇表、SSE 契约、REST 面和状态机。 |
| 参考 | [行为账本](../reference/behavior-ledger.md) | **（英文）** 代码必须遵守的不变量，多数由测试钉死 —— sandbox 生命周期、预览网关、回归行与陷阱。 |
| 运维 | [已知限制](operations/limitations.md) | 不是 bug 的边界。 |
| 运维 | [排障](operations/troubleshooting.md) | 症状 → 原因 → 处理。 |
| 决策 | [ADR 索引](../adr/index.md) | 产品为什么长成这样（英文）。 |
| 发布 | [发布流程](releasing.md) | 打 tag 与发布的路径。 |

另有两份文档在 `docs/` 之外，且在各自的主题上高于这里的任何一页：

- [`CONTEXT.md`](../../CONTEXT.md) —— **词汇表**：Project、Session、task
  stream、branch、turn、UI event、执行层（execution tier）、MCP connector、
  agent-config、artifact、SandboxProvider 在本仓库中各自指什么、不指什么。
- [`AGENTS.md`](../../AGENTS.md) —— 协作约定：标准动词（`make dev` /
  `uv run pytest` / `make check`）、门禁，以及一个改动如何成形与被接受。
