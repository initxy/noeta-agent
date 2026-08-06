# HTTP API 参考

`python -m noeta.agent` 提供的 REST + SSE 接口。下文所有路由都带 **`/api/v1`** 前缀
（表中省略），请求与响应均为 JSON。

> **规范性文档是
> [`docs/reference/wire-contract.md`](../../reference/wire-contract.md)（英文）。**
> 它冻结了 UI 事件词汇表（§2）、SSE 帧格式与启动顺序（§4）、REST 路径与状态码（§5）
> 以及会话状态机（§7），并规定了扩展规则（§8）。本页是同一套接口的阅读向导；两者不
> 一致时以契约为准，本页即 bug。

**没有任何鉴权。** 没有 cookie、没有 CSRF、没有管理员门：本产品是单用户本地产品，
不适合暴露在网络上；`HOST` 默认 `127.0.0.1` 正是因为这个。

**命令类接口以 202 应答**并返回一个很小的 body；所有可见变化都从该会话的 SSE 流到达。

**凭证不回程。** MCP 连接器的头和 env 值只存在服务端，读接口一律只返回排序后的
**名字**。

## 错误

所有错误共用同一个信封（§5.6）：

```json
{"error": {"code": "not_forkable", "message": "…"}}
```

`code` 是稳定的机器可读标识，`message` 是可能变化的人类文本。HTTP 状态码表示类别，
`code` 在类别内区分。未命中路由的 `/api/v1/*` 也会以同样形状返回
`404 unknown_endpoint`。

| 状态码 | 实际会遇到的 code |
| --- | --- |
| 400 | `invalid_path`、`invalid_mode`、`invalid_image`、`invalid_cursor`、`write_failed` |
| 404 | `unknown_project`、`unknown_session`、`unknown_task_stream`、`unknown_file`、`unknown_content`、`no_preview`、`unknown_endpoint` |
| 409 | `session_busy`、`duplicate_directory`、`duplicate_alias`、`no_task_stream`、`not_forkable`、`not_rewindable`、`not_resumable`、`task_terminal`、`file_conflict` |
| 422 | `invalid_directory`、`invalid_model`、`model_not_allowed`、`empty_message`、`invalid_answer`、`file_too_large`、`mcp_config` |
| 503 | `engine_unavailable` |

`file_conflict` 额外带一个**可选**字段 `current_mtime`，让「用我的覆盖」那条路径不必
再多读一次。

## 元信息

| 方法与路径 | 用途 |
| --- | --- |
| `GET /health` | `{status, version, provider, sandbox_available, data_dir}`。`provider` 是**解析后**的 provider（`mock` 或 `openai`）。`sandbox_available` 是一次带缓存、不在事件循环上跑的 `docker version` 实探 —— 仅供参考，不会覆盖项目已存的执行层。 |
| `GET /models` | `{models: [{id, label, default, efforts, default_effort}], provider}`。序列化**排除**后端字段 `gateway` / `context_window` / `max_output_tokens`。 |
| `GET /content/{hash}` | 按 SHA-256（64 位十六进制，否则 404）取 ContentStore 原始字节，`Content-Type` **由魔数嗅探**。用户气泡里的图片就是这样重新渲染的：事件流里只走 hash，从不走字节。 |

## 项目

| 方法与路径 | 用途 |
| --- | --- |
| `GET /projects` | `{projects: [row]}`。 |
| `POST /projects` | `201`。body `{name, directory, tier, create_directory?}`，`tier ∈ local\|sandbox`。相对路径或目录不存在（且未勾选 `create_directory`）→ **422**；目录已属于某个项目 → **409**。 |
| `GET /projects/{id}` | 单条。 |
| `PATCH /projects/{id}` | `{name?, tier?, default_model?, default_effort?, persona?, memory_enabled?}`。 |
| `DELETE /projects/{id}` | `204`。级联删除会话、task stream 和连接器，**绝不触碰目录**。 |
| `GET/PUT /projects/{id}/agent-config` | `{persona, default_model, default_effort, memory_enabled}`，作为一整份文档读写。 |
| `GET/POST /projects/{id}/connectors` | MCP 连接器。读接口返回 `header_names` / `env_names`，永远不返回凭证值。 |
| `PATCH/DELETE /projects/{id}/connectors/{alias}` | 修改 / 删除；SDK 拒绝的配置返回 `422 mcp_config`。 |

项目行为
`{id, name, directory, tier, persona, default_model, default_effort,
memory_enabled, version, created_at, updated_at}`。`version` 是单调计数器，客户端的
乐观更新协议按它做 last-writer-wins。

> **改 `tier` 只影响之后新建的会话。** 执行层在 `seed_start` 时被焊进 task，之后每一轮
> 都从那里解析。见
> [execution-tier-per-project](../../adr/execution-tier-per-project.md)（英文）。

## 会话

一个会话拥有**一条或多条 task stream**：创建时为零条，第一条消息 seed 出第一条，
每次 `fork` 追加一条兄弟流。所以各动词都接受可选的 `task_id`，详情接口也会列出这些流。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /projects/{id}/sessions` | `{sessions: [row]}`。 |
| `POST /projects/{id}/sessions` | `201`，返回详情形状。body `{title?}`。创建出的会话有**零条 task stream** —— 在有人真的说话之前，不建引擎任务、不建容器、不做 workspace 组装。 |
| `GET /sessions/{id}` | 行 + `task_streams: [{task_id, kind, source_task_id, branched_at_seq, created_at}]`。后两个字段在 `branch` 上有值、在 `root` 上为 null，而且是 fork 血缘的**唯一持久**记录 —— `branch_created` 是合成帧，从不重放。 |
| `PATCH /sessions/{id}` | `{title?, pinned?, archived?}`。 |
| `DELETE /sessions/{id}` | `204`。删掉的是对话索引；**保留项目目录与事件日志里的痕迹**，也绝不释放项目的容器（兄弟会话可能还在用）。 |
| `POST /sessions/{id}/messages` | **202** `{task_id}`。body `{text, images?, model?, effort?, skills?, task_id?}`。 |
| `POST /sessions/{id}/answer` | **202**。body `{question_id, answers, task_id?}`。 |
| `POST /sessions/{id}/interrupt` | **202**。body `{task_id?}`。停掉这一轮，保留对话。 |
| `POST /sessions/{id}/cancel` | **202**。终结对话 —— **终态**；之后再往该流发消息是 `409 not_resumable`。 |
| `POST /sessions/{id}/fork` | **201** `{task_id}`。body `{task_id, message_seq}`。**同一个会话**，新的流。没有可分叉的前序轮次时 `409 not_forkable`。 |
| `POST /sessions/{id}/rewind` | **200** `{task_id}`。body `{task_id, message_seq}`。就地把**这条**流回退到某用户消息之前并**还原 workspace 文件**（不新建子会话）；截断以 `rewind` SSE 帧下发。有轮次运行/等待时 `409 session_busy`；锚点非法时 `409 not_rewindable`。 |
| `GET /sessions/{id}/events` | SSE 流（见下）。 |
| `GET /sessions/{id}/files` | `{files: [{path, size, mtime}]}` —— 从**宿主机侧**读项目目录，所以 `local` 层能用、容器停了也能用。 |
| `GET /sessions/{id}/files/content` | `?path=&mode=text\|raw`。`text` → `{path, content, truncated, mtime}`，按 200 KB 截断；`raw` → 原始字节 + 嗅探出的 `Content-Type`。 |
| `PUT /sessions/{id}/files/content` | `{path, content, base_mtime}` → 与 `GET` 完全一致的 body。mtime 不匹配 → **409 `file_conflict`**。 |
| `POST /sessions/{id}/artifacts/resolve` | `{paths}` → `{artifacts: [{path, exists, size, updatedAt, preview}]}`，上限 80 条，`path` **原样回显**。 |
| `GET /sessions/{id}/preview` | `{token, port, panels}`；会话没有运行中的容器时 **404 `no_preview`**，客户端据此隐藏面板。 |

会话行为
`{id, project_id, title, title_generated, status, pinned, archived, version,
created_at, updated_at}`，其中 `status ∈ idle | running | waiting`。

`rewind`（"撤回上一轮"）**已暴露**：它就地把某条流回退到某用户消息之前并**还原 workspace
文件**。由于一个项目的所有会话共用一个目录，撤回可能回退另一个会话的改动——因此它带显式的
文件回滚警告、只在 root 会话的最新一条已提交消息上提供，且在有轮次运行时拒绝。

### 三个"停"不是一回事

- **`interrupt`** 停掉进行中的这一轮，对话仍然活着，下一条普通消息带着完整上下文接着
  同一条流跑。
- **`cancel`** 终结对话。终态，不可恢复。
- **`fork`** 不往源流写任何东西 —— 它在同一个会话里追加一条兄弟流，所以它返回的是
  task id 而不是 session id。

### `POST /messages` 的拒绝顺序

1. 有**问题待答**（`waiting`）或对话已终结（`not_resumable`）→ **409 `session_busy`**。
   轮次**正在跑**不再被拒：消息会作为轮次内的引导（steer，`inject_goal`）注入，在该轮的
   下一个边界投递，并以普通 `user_message` 呈现。引导不带本轮的 `model` / `effort` /
   `skills` —— 它跟随正在运行那一轮的绑定。
2. 附件不合法 → **400 `invalid_image`**，且会话状态不变、**这一轮从未被 seed**。
3. 空消息且无附件（`empty_message`）、模型或推理强度不在目录内（`invalid_model` /
   `model_not_allowed`）→ **422**，且永远不会打到 provider。

失败轮次的重试路径也是这里，而且刻意不做成特例：`turn_failed` 只是把这一轮停泊住，
没有封账本，所以会话是 `idle`，一条普通消息就能恢复。

### 图片附件

`images: [{media_type, data_base64}]`。MIME 白名单 `png` / `jpeg` / `gif` / `webp`，
合法 base64，每张 ≤ 5 MB；违反即 **400**，且这一轮从未被 seed。字节进入内容寻址存储、
以 `ImageBlock` 随用户轮次流转；UI 事件只带 `{hash, media_type}`，前端通过
`GET /content/{hash}` 还原。

## SSE 流

```
GET /sessions/{id}/events?since_seq=<int>&task_id=<str>
```

每会话一条流，`text/event-stream`。帧是手写的：

```
id: <seq>            <- seq 为 null 时「不写这一行」
event: <type>
data: <json>         <- 单行
```

字段分隔符是 `": "` —— 键、冒号、恰好一个空格。

- **持久帧带 `seq`、可重放。** 合成帧没有 `seq`、**没有 `id:` 行**、从不重放。
- **重放即重新推导。** 连接时后端用与实时路径同一个 translator 重放该会话的
  EventLog，跳过 `seq <= since_seq`，然后发一个合成的 `replay_done` 再切到实时
  （重放/实时重叠部分按 seq 去重）。不存在被存下来的 UI 投影。`since_seq = 0` 是
  **全量**重放，也就是正常的首次连接。
- **`?task_id=` 按流过滤**：`data._task` 缺失（会话级）或等于该值的帧通过。
- 静默 15 秒发一个 `: ping` 注释帧作为心跳。

持久词汇表：`user_message`、`assistant_text`、`thinking`、`recall`、`tool_call`、
`tool_result`、`memory_op`、`skill_activated`、`todo_update`、`subtask_started`、
`subtask_finished`、`question`、`question_answered`、`compaction`、`llm_retry`、
`turn_started`、`turn_finished`、`error`；合成帧：`delta`、`replay_done`、
`session_meta`、`branch_created`，以及子任务流的 `tool_call` / `tool_result` /
`subtask_finished`。每一帧的 `data` 都带 `_task`；每个持久帧的 `data` 还带可选的
`ts`（源信封的 `occurred_at`，epoch 秒）。

**逐字段含义、截断规则和 `turn_finished` 的完整映射见 wire contract §2，这里不复述**
—— 冻结词汇表的第二份副本只是第二个会写错的地方。

两条值得重复的规则，因为破坏任何一条都是静默的：

- **`delta` 帧没有 `id:` 行。** 有的话，恢复游标会越过那些从未送达客户端的信封，
  重连后永远跳过它们。
- **子任务流的帧不带 `seq`。** 子任务独立计数 seq，带上会与父流去重逻辑相撞。
  （名字叫 `subtask_*` 但来自**根流**信封的帧是普通持久帧，带根流的 seq。）

## Trace

| 方法与路径 | 用途 |
| --- | --- |
| `GET /trace/sessions/{id}/raw-events` | `?cursor=` —— 会话各条流及其子任务树未经翻译的 `EventEnvelope`，按时间排序。 |

游标是一个 **`{task_id: last_seq}` 的 JSON 映射**，每次响应回显：每条流独立计数 seq，
把它传回来即可严格增量。子任务流在同一轮里由 spawn 标记发现。这是原始信封**唯一**过线
的地方 —— 诊断面，不是产品契约。

## 路径围栏

每一个指向 workspace 文件的路径参数都走 `resolve_within`：拒绝空路径和绝对路径，并且
在做包含判断前对候选路径和根目录**都**做 `realpath` —— 这既挡住 `../` 逃逸，也挡住
workspace 内部指向外面的符号链接。

## 参见

- [wire contract](../../reference/wire-contract.md) —— 规范性（英文）
- [产品参考](noeta-agent.md) —— 架构与启动模式
- [配置](configuration.md) —— 每一个 `.env` key
