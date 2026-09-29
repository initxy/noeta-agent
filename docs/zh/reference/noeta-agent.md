# noeta-agent 工作台（`python -m noeta.agent`）

Noeta 的官方产品是一个**单用户、本地优先的 agent 工作台**：FastAPI 后端加
React/TypeScript SPA，作为单个进程跑在你自己的机器上。你针对一个**真实目录**建一个
**项目**（Project），在它上面开**会话**（Session），agent 读写的就是那个目录 ——
按项目决定是在容器里还是直接在本机。没有账号、没有登录、没有共享，也没有需要部署的
服务端。

背后的决策在 [`docs/adr/`](../../adr/index.md)（英文）；它说的 wire 冻结在
[wire contract](../../reference/wire-contract.md)（英文）；词汇表是
[`CONTEXT.md`](../../../CONTEXT.md)。

## 启动

**唯一**入口是 `python -m noeta.agent` —— 零参数，所有配置来自 `./.env` 和环境变量
（见[配置](configuration.md)）。它在同一个端口（默认 8000）上同时提供 `/api/v1/*`
下的 REST + SSE 与构建好的 SPA。从一份 checkout 出发：

```bash
make install   # 首次：uv sync + 前端依赖
make run       # 构建 SPA + python -m noeta.agent  → http://127.0.0.1:8000
make dev       # 热重载：后端 8000 + vite dev 5273（走代理）
make check     # 本地 CI 门禁
```

### 启动模式

- **零凭证（默认）。** 一切留空：确定性 **mock provider**（脚本化演示 —— 一个澄清
  问题、一次写文件、一个回答）、SQLite 存储、不需要 Docker。完全离线，也正是测试套件
  与 CI 跑的模式。**任何模式下都没有登录页。**
- **真实网关。** `LLM_BASE_URL` + `LLM_API_KEY` 指向任意 OpenAI-Responses 兼容网关
  （`/responses` 会被自动追加）；模型菜单是 `models.json`；可选的第二网关服务于
  `models.json` 里打了 `"gateway": "secondary"` 的模型。见
  [接入网关](../how-to/configure-provider.md)。
- **sandbox 执行层。** 没有开关可拨：执行层为 `sandbox` 的项目会拿到一个基于现成
  [AIO Sandbox 镜像](https://github.com/agent-infra/sandbox)的容器，外加实时的
  Preview 与 Terminal 面板。`GET /health` 会告诉你这台机器能不能跑。

深链接（`/project/x/session/y`）能扛住硬刷新：任何既不是文件也不是 API 的路径都回落到
SPA 入口，因为在这个产品里 URL 是权威。

## 架构

单进程、单部署单元，缝（seam）是接口而不是服务。

```text
web/（React SPA）  ──  /api/v1 REST + 每会话一条 SSE
        │
noeta.agent.api    router：health、meta、content、projects、sessions、
        │          events（SSE）、files（含 artifacts、preview）、trace
noeta.agent.host   引擎宿主：唯一的 SDK Client 与驱动轮次的 AgentHost、
        │          信封→UI 事件的 translator、事件 hub 与状态机、provider 装配、
        │          执行层策略、记忆根、Docker sandbox provider 与空闲回收、
        │          preview gateway
noeta.agent.store  应用 SQLite：projects、sessions、task streams、MCP 连接器
        │
     noeta.sdk     进入引擎的唯一通道
```

四个结构性决策承担了大部分重量：

- **一个会话拥有一条或多条 task stream。** `fork` 往同一个会话里追加**兄弟**流，
  所以每一帧 UI 事件都带 `_task` 标签、SSE 端点带 `?task_id=` 过滤。把会话塌缩成单个
  task id，在 branch 落地那天就得推翻重来。
- **wire 是翻译过的，不是原始的。** 一个确定性的、无状态的纯函数
  （`host/translator.py`）把 `EventEnvelope` 变成扁平的 UI 事件词汇表；重放与实时共用
  它，所以流不可能与日志漂移。重放是靠 `since_seq` **重新推导**的 —— 不存在被存下来的
  UI 投影。token delta 作为不带 SSE id 的临时帧同流而下，从不持久化、从不重放。原始
  信封只出现在 trace 面。
- **执行是项目级的层。** 一个 `Client` 服务两层；唯一切换的是
  `HostConfig.sandbox_policy`，其 key 是项目目录。工具始终注册、系统提示词与层无关、
  文件面不按层设门。见
  [execution-tier-per-project](../../adr/execution-tier-per-project.md)（英文）。
- **没有鉴权，也没有授权弹窗。** 权限被旁路（`bypassPermissions`，而且任何驱动轮次的
  调用都不传 per-turn 覆盖 —— 传了会把所有门重新武装起来）。约束 agent 的是项目选的
  执行层，加上单根写入墙。

### 存储

`DATA_DIR` 下两个 SQLite 文件，从不混用：`app.db`（本产品的
projects / sessions / task streams / 连接器，用一份有序迁移列表升级，版本记在
`schema_version`）与 `noeta.db`（引擎的 EventLog + ContentStore + Dispatcher，由 SDK 的
存储适配器拥有）。EventLog 始终是唯一真相，`app.db` 只是索引。

### 并发

引擎跑 `AGENT_NUM_WORKERS` 个常驻 worker 线程，因此不同会话的轮次并行推进，同一会话
内部仍然串行。**读路径从不与驱动队列共用**：重放、原始事件、内容读取和文件面都走异步
线程池 —— 一轮活跃对话可能占住一个 worker 数分钟，把读排在它后面会让每一个会话（包括
已经结束的）的 SSE 一起挂住。

## sandbox 层细节

- **每个项目一个容器**，名为 `noeta-sbx-<project_id>` —— 一个项目的所有会话共用它的
  目录，每会话一个容器会把同一个目录挂进好几个容器里互相打架。
- **两级空闲回收。** `docker stop` 归还内存与 CPU，容器本体、写入层和端口映射都还在
  （恢复时数秒 attach）；`docker rm` 回收磁盘，且**不可逆** —— 容器规格只存在于
  `docker run` 那一刻。判据是「该项目没有任何会话 running 或 waiting」。
- **隔离是进程 + 挂载文件系统**，不是完整牢笼：容器只看到被挂进去的东西，而对挂载路径
  的写入会直接落到宿主机文件系统上。
- **实时面板在另一个 origin 上。** 容器把 noVNC、web 终端和 code-server 都挂在一个端口
  上；preview gateway 用一个不可猜的 token 把其中一部分重新发布到自己的端口，并在发现
  接口里返回一个 `panels` 映射，客户端只负责把 origin 拼上去（那三条路径各有一个曾经
  付过代价的怪癖：绝对的 websockify 路径、一个必须没有的尾斜杠、一个必须有的尾斜杠，
  在客户端重建它们等于三次写错的机会）。面板栏露出的是 Preview 与 Terminal。那个
  origin 刻意是空白的 —— 没有 API、没有 SPA、没有我们的任何东西 —— 因为这些 iframe
  需要 `allow-same-origin`。绑定失败只会损失面板，绝不影响对话。
- **关停不是可选项。** 交互会话永远停在 suspended、从不到达根终态，所以容器只能靠
  `Client.shutdown()` 的有序关停回收（workers → observers → OTLP → 容器）。跳过它的
  进程会为每个活跃项目泄漏一个容器。

## 前端

`web/src` 是分层的，而且这个分层是**门禁**而非注释（`npm run layering`，属于
`make check`）：

```text
web/src/
├── app/          与框架无关：API 客户端、SSE 读取、wire 类型、
│                 fold、草稿语法、artifact 推导引擎
└── react-app/
    ├── kernel/   provider、platform、通知 store
    ├── infra/    query client、共享缓存
    ├── design-system/
    ├── domains/  session/ project/ panels/ settings/ trace/
    └── shell/    路由、侧边栏、workbench、命令面板、通知中心
```

`app/**` 不得 import React 或 `react-app/` 下的任何东西；design system 不得 import
kernel / infra / domains / shell；一个 domain 不得 import 兄弟 domain（只有 shell 被
允许组合它们）；不允许环。

路由决定屏幕上是什么：`/`、`/project/:projectId/session/:sessionId`、
`/project/:projectId/settings/:tab`（General / Agent / Connections / Memory /
Advanced）、`/trace/:sessionId`。**唯一**的进程级全局状态是 workbench —— 保留的标签页、
分屏、聚焦窗格 —— 因为 URL 表达不了它；它存在 `sessionStorage` 里，能扛刷新、随浏览器
标签页一起消失。

## 诚实的边界

- **`local` 层没有隔离，也没有授权关卡。** 写入被围在项目目录内；`shell_run` 不受
  约束。
- **会话的执行层在第一轮就固定**，改项目的层只影响新会话。
- **一个项目的所有会话共用一个目录且没有锁。** `rewind`（"撤回上一轮"）因此在还原文件时
  带显式警告，且只在 root 会话上提供；artifact 保存带乐观锁。
- **单用户、单进程、单机**，没有任何鉴权。
- 若干能力开关是没有读者的配置 —— 见[配置](configuration.md#agent-能力)里的说明。

完整清单见[已知限制](../operations/limitations.md)。

## 参见

- [HTTP API 参考](http-api.md) —— 每一个路由
- [wire contract](../../reference/wire-contract.md) —— 规范性（英文）
- [配置](configuration.md) —— 每一个 `.env` key
- [使用工作台](../how-to/use-the-workbench.md) —— 界面走查
