# 排障

常见问题，按**症状 → 原因 → 处理**组织。不是 bug 的架构边界见[已知限制](limitations.md)。

## agent 每次都演同一段脚本

**症状：** 明明配了网关，`GET /api/v1/health` 却报 `{"provider": "mock"}`，每个会话都在
演同一条"提问 → 写文件 → 回答"。

**原因：** `LLM_PROVIDER=auto` 只有在 `LLM_BASE_URL` 与 `LLM_API_KEY` **都**设置时才走
网关；任何一个为空就静默回落。

**处理：**

- 把两个 key 写进**你启动进程的那个目录**下的 `.env`。环境变量优先于文件 —— 检查是否
  有陈旧的导出变量把其中一个清空了。
- `LLM_BASE_URL` 是网关**根地址**，provider 自己追加 `/responses`。
- 用 `LLM_PROVIDER=openai` 让回落变响：直接启动失败，而不是降级。

## 模型在这一轮开始前就被拒了

**症状：** `POST /messages` 返回 **422** `invalid_model` 或 `model_not_allowed`。

**原因：** 模型菜单来自 `./models.json` 而不是网关；不在目录内的模型或推理强度会被同步
拒绝 —— 这是刻意的，好让笔误永远不会打到（也不会计费到）provider。

**处理：** 把模型按网关实际提供的 id 加进 `models.json`，并列出它支持的推理档位。注意厂商
命名（Anthropic 的 id 带日期后缀）。

## 长对话从不压缩

**症状：** 上下文一直涨到网关报错，转录里从没出现 `compaction` 帧。

**原因：** 该模型的 `context_window` 用了默认值或太小，导致压缩触发太晚（窗口极小时表现
得像整体关闭）。

**处理：** 在 `models.json` 里那条填上真实的 `context_window` 和 `max_output_tokens`。
凡是还在用默认值的模型，启动时都会打警告。

## 建项目时没有 sandbox 这一层

**症状：** 表单里只有 `local`。

**原因：** `GET /api/v1/health` 报了 `sandbox_available: false` —— 实探
`docker version` 没找到 daemon（或超时了）。

**处理：** 启动 Docker 再刷新。探测结果缓存 30 秒。

## `sandbox` 项目表现得像本地

**症状：** 项目的层写着 `sandbox`，但文件直接落在宿主机上、没有容器，
`GET /sessions/{id}/preview` 也 404。

**原因：** 没有接入 sandbox provider 时（启动时没有 Docker），执行策略根本不会被询问，
所有任务都在本机跑。另外：执行层在会话**第一轮**就被焊死，所以在项目还是 `local` 时创建
的会话会永远保持那一层。

**处理：** 保证进程启动时 Docker 可用，并在改了执行层之后**新建会话**。

## 预览面板一直不出现

**症状：** sandbox 项目上没有 Preview / Terminal 按钮。

**原因：** 可能是：项目是 `local`；容器还没被分配（还没跑过一轮）；空闲回收已经把它删了；
或者 preview origin 没能绑定端口（发现结果里 `port: null`）—— 绑定失败只损失面板，不影响
对话。

**处理：** 先跑一轮；看后端日志里有没有绑定错误；有防火墙或隧道时固定
`SANDBOX_PREVIEW_PORT`（面板走的是**第二个端口**，只转发主端口是不够的）。

## 保存 artifact 返回 409

**症状：** 编辑器拒绝保存，并给出 "Reload theirs" / "Overwrite with mine" 两个选择。

**原因：** 自从填满编辑器的那次读取以来，文件在磁盘上变了 —— 另一个会话、正在跑的 agent，
或者你自己的编辑器。这是乐观锁在起作用，不是故障。

**处理：** 选一个。刻意没有三方合并。如果这件事频繁发生，说明你有两个活跃会话在写同一批
文件 —— 见 [project-model](../../adr/project-model.md)（英文）。

## 会话以 409 拒绝新消息

**症状：** `POST /messages` 返回 **409** `session_busy` 或 `not_resumable`。

**原因：** `session_busy` 表示有**问题待答**（`waiting`）—— 回答它，或者 Stop。
轮次**正在跑**不再算这种"忙"：往里发消息会作为轮次内的引导（steer，`inject_goal`）投递，
而不是被拒。`not_resumable` 表示这个对话被 **cancel** 过，那是终态：cancel 就是 cancel，
新的对话是新的会话。

**处理：** 想停掉一轮但保留对话，用 **Stop**（`interrupt`），不要用 Cancel。若某次发送被
`session_busy` 拒绝，说明输入框上方有一个待答的问题 —— 回答它。

## 某一轮以 `turn_failed` 结束

**症状：** 对话里出现一条"这一轮失败了"的行内提示，输入框仍然可用。

**原因：** provider 故障会把这一轮停泊住而不是封掉账本。这是设计行为，会话是 `idle`。

**处理：** 直接再发一次 —— 一条普通消息会带着完整上下文恢复**同一个** task。刻意没有单独
的重试动词。

## provider 返回 401

**症状：** 轮次因网关鉴权错误失败。

**原因：** key 缺失、过期或没有权限。

**处理：** 检查 `LLM_API_KEY`（主网关）或 `SECONDARY_LLM_API_KEY`
（第二网关）—— 两个网关都用 `Authorization: Bearer`。在公司代理后面记得设 `HTTPS_PROXY`。

## 浏览器里是一段构建提示而不是界面

**症状：** 一个纯文本页面，说 web UI 还没有构建。

**原因：** 没找到 SPA 产物 —— 打包内的和 `web/dist` 都没有。

**处理：** `make web`（或在 `web/` 里 `npm run build`）后刷新。API 本来就是活的，可以先
试 `/api/v1/health`。

## 大改之后 editable 安装像是旧的

**症状：** 你在 `noeta/agent/**` 下改的代码不是实际运行的那份。

**原因：** `uv` 的 editable 构建按 `pyproject.toml` 缓存，而不是按包目录树；重建包目录后
可能仍然留着旧构建。它看起来像打包 bug，其实不是。

**处理：** `uv sync --reinstall-package noeta-agent`。全新 clone 不受影响。

## 加了 skill 却没反应

**症状：** 放进 `<项目>/.noeta/skills/` 的新 `SKILL.md` 从不被激活。

**原因：** workspace 的 skill 注册表在该 workspace 的引擎首次编译时解析，并在进程内缓存。

**处理：** 重启进程。（另外：skill 控制工具在菜单为空时会自我关闭，所以空项目本来就没有
skill 这一步。）

## 参见

- [已知限制](limitations.md) —— 不是 bug 的边界
- [配置](../reference/configuration.md) —— 每一个 key
- [HTTP API 参考](../reference/http-api.md) —— 完整错误码表
