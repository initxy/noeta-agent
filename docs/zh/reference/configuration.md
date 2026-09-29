# 配置

`python -m noeta.agent` 通过**进程工作目录下的 `./.env`** 加环境变量配置 —— 环境变量
优先于文件，文件优先于内置默认值。没有任何 CLI 参数。事实来源：
`noeta/agent/config.py`（pydantic-settings）；[`.env.example`](../../../.env.example)
是带注释的起步副本。

**每个 key 都是可选的。** 全留空时工作台完全离线启动：确定性 mock LLM、SQLite 存储、
不需要 Docker、不需要凭证，也没有登录页。

**未知 key 会被忽略**，所以旧 `.env` 不会导致启动失败。特别地，全局沙箱开关已经不
存在了 —— 执行层是项目级属性，残留的 `SANDBOX_ENABLED=true` 不起任何作用。

相对路径（`DATA_DIR`、`PROJECTS_DIR`、`MODELS_CONFIG`）相对**进程工作目录**解析，
而不是包所在目录。

## 服务

| Key | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 监听网卡。本产品没有任何鉴权；绑到可达网卡等于把一个能执行 shell 的 agent 暴露出去。 |
| `PORT` | `8000` | 监听端口。 |
| `LOG_LEVEL` | `INFO` | 后端日志级别。 |
| `CORS_ORIGINS` | *(空)* | 逗号分隔的允许来源。空 = **完全不装 CORS 中间件**，这也是打包后的常态（SPA 同源提供）。只有前端被单独托管时才需要；`make dev` 的 vite 代理不需要。 |

## 路径与存储

| Key | 默认值 | 说明 |
| --- | --- | --- |
| `DATA_DIR` | `data` | 可写数据根目录（见下）。 |
| `PROJECTS_DIR` | *(空)* | "帮我创建项目目录" 时的父目录。空 = `DATA_DIR/projects`。你指向的既有目录不受它影响。 |

`DATA_DIR` 布局（启动时创建）：

```text
data/
├── app.db          # 本产品的库：projects、sessions、task streams、
│                   # mcp_connectors、schema_version
├── noeta.db        # 引擎存储：EventLog + ContentStore + Dispatcher
├── memories/       # 每个「项目」一个长期记忆池
│   ├── <project_id>/
│   └── _quarantine/   # 无法解析出项目的任务：宁可没有记忆，
│                      # 也绝不用别的项目的记忆
├── workspaces/     # 仅作为兜底 workspace 根 —— 项目的会话用项目自己的目录
└── projects/       # PROJECTS_DIR 的默认位置
```

两个库都是 SQLite 文件，且从不混用。项目目录在用户指定的位置，`DATA_DIR` 下不保存
它们的内容。

## LLM 网关

| Key | 默认值 | 说明 |
| --- | --- | --- |
| `LLM_PROVIDER` | `auto` | `auto` \| `openai` \| `mock`。**`auto` 在 `LLM_BASE_URL` 与 `LLM_API_KEY` 都设置时解析为 `openai`，否则为离线 `mock`**（确定性脚本 provider —— 零凭证模式）。显式写 `openai` 却没有凭证会**启动即失败**：那是笔误，不是回落。 |
| `LLM_BASE_URL` | *(空)* | 主网关根地址 —— 任何 **OpenAI-Responses 兼容**端点；provider 自己追加 `/responses`。 |
| `LLM_API_KEY` | *(空)* | 主网关凭证。 |
| `SECONDARY_LLM_BASE_URL` | *(空)* | 可选的第二网关（同一套 Responses 协议）。 |
| `SECONDARY_LLM_API_KEY` | *(空)* | 它的凭证。两者都设置才算配置完成；第二网关只叠加在生效的主网关之上，不能单独存在。 |
| `MODELS_CONFIG` | `models.json` | 模型菜单文件路径（见下）。 |
| `LLM_REQUEST_TIMEOUT` | `300.0` | 单请求超时（秒）。 |
| `LLM_MAX_TOKENS` | `8192` | 输出 token 上限。 |
| `TITLE_MODEL` | *(空)* | 异步生成会话标题用的模型，**必须是非推理模型** —— 该调用发送推理强度 `"none"`。空 = 默认对话模型。mock provider 下不生成标题，改用消息首行。 |

### `models.json`

定义模型菜单（`GET /api/v1/models`）。每条：`id`、`label`、`default`（有且只有一条）、
`efforts`、`default_effort`，以及**不会序列化给客户端**的后端字段：`gateway`
（`"openai"` = 主网关，`"secondary"` = 路由到第二网关）、`context_window` /
`max_output_tokens`，以及能力标志 `supports_vision` / `is_reasoning`。

自定义模型请补上 `context_window` / `max_output_tokens`：注册模型规格是上下文压缩生效
的前提，也决定输出 token 上限。不填也会注册该模型 —— 用一个保守默认值并在启动时打
**警告** —— 所以压缩不会静默失效；请填真实值让它准确并消除警告。接受图片输入的模型请
设 `"supports_vision": true`，否则发给它的此类请求会被拒绝。文件缺失或无法解析时降级
为一个 fallback 模型并打警告；后端不会因为模型配置崩溃。

## sandbox 执行层

以下 key 配置的是「执行层为 `sandbox` 的项目」所使用的容器。**没有全局开关**：执行层
按项目存储；机器上没有 Docker 时这一层根本跑不起来（`GET /health` 会报
`sandbox_available: false`，界面隐藏该选项）。

| Key | 默认值 | 说明 |
| --- | --- | --- |
| `SANDBOX_IMAGE` | `ghcr.io/agent-infra/sandbox:latest` | 现成的 AIO Sandbox 镜像；需要额外工具链就在它之上构建自己的镜像。 |
| `SANDBOX_MEMORY` | `2g` | 单容器内存上限。 |
| `SANDBOX_CPUS` | `2` | 单容器 CPU 上限。 |
| `SANDBOX_API_KEY_ENV` | `SANDBOX_API_KEY` | 持有容器 API key 的环境变量**名字**（不是值本身）—— 供给容器时读取，注入容器与 ExecEnv 鉴权，从不被记录。变量未设置 = 容器不带鉴权运行（仅限本机）。 |
| `SANDBOX_PREVIEW_PORT` | `0` | 实时 Preview / Terminal 面板所用端口。刻意与主端口**不同源**（这些 iframe 需要 `allow-same-origin`，所以承载它们的 origin 上不能有我们的任何东西）。`0` = 临时端口，通过 `GET /api/v1/sessions/{id}/preview` 发现；有防火墙或隧道时把它固定下来。 |
| `SANDBOX_IDLE_STOP_HOURS` | `1.0` | 空闲一级回收：`docker stop` —— 内存与 CPU 还给宿主机，容器本体、写入层和端口映射都保留，恢复时数秒内重新 attach。 |
| `SANDBOX_IDLE_REMOVE_HOURS` | `24.0` | 空闲二级回收：`docker rm` —— 回收磁盘。**不可逆**：容器规格只存在于 `docker run` 那一刻，删掉就无法重建。请显著大于 stop。 |
| `SANDBOX_IDLE_CHECK_INTERVAL_HOURS` | `0.1` | 回收线程轮询间隔。两个空闲 key 都为 `0` = 不启动回收线程。 |

容器**按项目**供给，名为 `noeta-sbx-<project_id>` —— 因为一个项目的所有会话共用它的
目录。因此回收判据是「该项目没有任何会话处于 running 或 waiting」。

## agent 能力

| Key | 默认值 | 说明 |
| --- | --- | --- |
| `MEMORY_TOOLS_ENABLED` | `false` | 本意是控制 `memory_write/read/search/archive` 与自动召回。**当前无读者**，见下方说明。 |
| `MEMORY_CONSOLIDATION` | `true` | 本意是控制后台记忆整理。**当前无读者。** |
| `MEMORY_CONSOLIDATION_DEBOUNCE_HOURS` | `24.0` | 两次整理之间的最小间隔。**当前无读者。** |
| `SUBAGENT_ENABLED` | `false` | 本意是控制子 agent 委派。**当前无读者。** |
| `AGENT_NUM_WORKERS` | `4` | 常驻引擎 worker 线程数：**不同**会话的轮次并发推进，同一会话内部的轮次仍由引擎串行化。设为 `1` 退化为单 worker。**生效。** |

> **明写出来的已知缺口。** 上表中的四个 key，加上项目级的 `memory_enabled` 开关，
> **当前都没有读者**：
>
> - 记忆与子 agent 工具由 agent preset 的激活元组无条件挂载，按项目切换需要在 seed
>   时选择第二套编译好的 recipe —— 那是尚未做的 agent 身份层工作；
> - 记忆**整理**是宿主可调用的一次 pass（SDK 面上的 `run_consolidation`），本产品从
>   不调用它，所以两个整理 key 什么也没配置到。整理用的 agent 已经注册好了，缺的只是
>   触发这一半。
>
> 设置这些 key 不会改变任何行为。保留而不是删掉，是因为这些开关代表真实意图；下一个
> 接手 agent 配置面的人要么把它们做出来，要么把 key 删掉。

## 可观测性

| Key | 默认值 | 说明 |
| --- | --- | --- |
| `OTLP_ENDPOINT` | *(空)* | OTLP trace 导出：**完整**的 OTLP/HTTP traces URL（如 `http://localhost:4318/v1/traces`）。空 = 关闭。导出**只由这个 key 开启** —— 刻意不把 OTel 标准的 `OTEL_EXPORTER_OTLP_ENDPOINT` 当作开关，免得别人为其它应用注入它时让本进程悄悄开始上报。 |
| `OTLP_HEADERS` | *(空)* | 每次导出请求附加的头，OTel 形式 `k=v,k2=v2`，值按百分号编码（`authorization=Bearer%20token`）。未设置时回落到 `OTEL_EXPORTER_OTLP_HEADERS` —— 头本身永远不开启任何东西，只有 `OTLP_ENDPOINT` 设置时才生效。格式错误的键值对会被丢弃。 |

## 参见

- [产品参考](noeta-agent.md) —— 架构与启动模式
- [HTTP API 参考](http-api.md) —— 每一个路由
- [接入网关](../how-to/configure-provider.md)
