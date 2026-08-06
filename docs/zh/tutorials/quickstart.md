# 快速开始：5 分钟跑通工作台

**你会做什么：** 零凭证启动工作台，把它指向一个真实目录，跑完一段脚本化对话，
再看它从事件日志里重放出来。**不需要 API key、不需要 Docker、没有账号** ——
默认的 mock provider 是一个确定性的 LLM 替身，而且**没有登录页**。

## 1. 安装

需要 Python 3.12+（配 [uv](https://docs.astral.sh/uv/)）和 Node 20+。

```bash
git clone https://github.com/initxy/noeta-agent && cd noeta-agent
make install        # uv sync + 前端依赖
```

## 2. 启动

```bash
make run            # 构建 SPA + python -m noeta.agent
```

服务起在 <http://127.0.0.1:8000>，用离线 mock LLM，数据落在 `./data`。底层入口
始终是 `python -m noeta.agent` —— 零参数、只读环境变量、没有 flag。Ctrl-C 停止。

## 3. 建一个项目

打开页面。先准备一个空目录 —— agent 马上要往里真写文件：

```bash
mkdir -p ~/noeta-demo
```

表单里填：名字、该目录的**绝对路径**（例如 `/home/you/noeta-demo`），执行层选
**`local`**。

> `local` 表示 agent 直接跑在你的机器上，没有容器、没有逐次授权弹窗。它的写入被
> 围在这个目录里，但 shell 命令**不受围栏约束**。本教程请用一个可丢弃的目录。

## 4. 对话

新建会话，发一句：

```text
Write me a short report on the state of this project.
```

mock provider 会用**真实**的机制演一遍脚本：

1. agent 先问你一个澄清问题 —— 回答它；
2. 它把 `report.md` 写进你的目录；
3. 它给出回答。

每一步都是被记录的事件。确认文件真的存在：

```bash
cat ~/noeta-demo/report.md
```

## 5. 看底下的日志

对话进行到一半时刷新页面。转录会被**一模一样地重建**，因为界面是靠
`since_seq` 从事件日志**重新推导**的，而不是相信内存里存着的东西 —— 你看到的
内容没有任何一份被存下来的副本。

再打开侧边面板：`report.md` 会作为 **artifact** 出现 —— 客户端从转录里猜到它，
服务端确认了它真的存在。打开、编辑、保存。

想看原始记录，打开 `/trace/<session id>` —— 该会话未经翻译的引擎事件信封
（LLM 轮次、工具调用、token 与缓存统计）。

## 6. 试试轮次控制

- 发一个更长的请求，然后按 **Stop**（或连按两次 `Escape`）。这一轮停下，对话仍
  然活着，下一条消息会接着同一条流跑。
- 把鼠标移到**你自己**发的某条消息上，用 **Edit & retry**。这会在同一个会话里
  分出一条 branch —— 原来的那条完好无损，随时可以切回去。

## 下一步

- **接真实模型** —— [接入网关](../how-to/configure-provider.md)：任意
  OpenAI-Responses 兼容网关，两行 `.env`。
- **真正用起来** —— [使用工作台](../how-to/use-the-workbench.md)。
- **把 agent 关起来** —— 建一个 `sandbox` 层的项目（需要 Docker）：同一个目录
  被挂进容器，侧边面板多出容器自己的浏览器和终端。
- **知道边界在哪** —— [已知限制](../operations/limitations.md)。
