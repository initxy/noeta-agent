# Security Policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security-sensitive reports.

Instead, use GitHub's private vulnerability reporting:
[**Report a vulnerability**](https://github.com/initxy/noeta-agent/security/advisories/new).
We aim to acknowledge within a few days and will coordinate a fix and
disclosure with you.

## Threat model — read this before deploying

`noeta-agent` is a **single-user, local-first** tool. Its security posture is a
deliberate design, documented in full at
[`docs/operations/limitations.md`](docs/operations/limitations.md). The points
that matter most:

- **No authentication, no multi-user model.** There is no login and no
  authorization anywhere in the API. App state is a local SQLite file. **Keep
  the server bound to `127.0.0.1` (the default).** An exposed workbench is an
  unauthenticated remote shell.
- **The `local` execution tier has no isolation and no approval gate.** A
  `local` project runs the agent's file and shell tools on your machine, as you.
  File writes are fenced to the project directory, but **`shell_run` is not
  fenced** — a shell command can touch anything your user can. Choose the
  `sandbox` tier for work you do not want reaching the rest of the machine.
- **Sandbox isolation is process + mounted-FS, not a full jail.** The project
  directory is a bind mount, so writes land on the host filesystem directly. For
  genuinely untrusted code, run the whole workbench inside a VM.
- **Preview panels are token-guarded, not authenticated.** The container's
  browser/terminal are republished on a separate origin behind an unguessable
  token; keep the whole thing on localhost.

Reports that simply restate these documented, by-design boundaries are not
vulnerabilities. A report that breaks an invariant the product *does* claim to
hold — e.g. a file write escaping the project directory fence, a credential
leaking into a client response, or the preview token being bypassable — is.

## Supported versions

Only the latest released version on PyPI receives fixes. Pin a version and
upgrade to pick up security patches.

---

# 安全策略

## 报告漏洞

对涉及安全的报告，请**不要**开公开的 GitHub issue。

请使用 GitHub 的私密漏洞报告：
[**Report a vulnerability**](https://github.com/initxy/noeta-agent/security/advisories/new)。
我们会争取在几天内确认，并与你协调修复与披露。

## 威胁模型 —— 部署前必读

`noeta-agent` 是一个**单用户、本地优先**的工具。它的安全姿态是刻意的设计，完整
文档见 [`docs/zh/operations/limitations.md`](docs/zh/operations/limitations.md)。
最要紧的几点：

- **无认证、无多用户模型。** API 里没有登录、没有任何授权。应用状态是本地一个
  SQLite 文件。**请让服务保持绑定在 `127.0.0.1`（默认值）。** 一个暴露在网络上
  的工作台就是一个无认证的远程 shell。
- **`local` 执行层没有隔离、没有授权弹窗。** `local` 项目让 agent 的文件和 shell
  工具直接以你的身份跑在你的机器上。文件写入被围在项目目录里，但 **`shell_run`
  不受围栏约束** —— shell 命令能碰到你能碰的一切。不想让改动触及机器其余部分的
  工作，请选 `sandbox` 层。
- **Sandbox 隔离是进程 + 挂载文件系统级，不是完整的牢笼。** 项目目录是 bind
  mount，写入会直接落到宿主文件系统。真正不可信的代码，请把整个工作台跑在 VM 里。
- **预览面板是 token 守卫、不是认证。** 容器的浏览器/终端在一个独立 origin 上、
  用一个不可猜测的 token 重新发布；请把整体保持在 localhost。

只是复述这些已记录的、设计使然的边界，不算漏洞。而打破了产品*确实*声称要守住的
不变量 —— 例如文件写入逃出项目目录围栏、凭证泄漏进客户端响应、或预览 token 可被
绕过 —— 才算。

## 支持的版本

只有 PyPI 上最新发布的版本会收到修复。请固定版本，并通过升级来获取安全补丁。
