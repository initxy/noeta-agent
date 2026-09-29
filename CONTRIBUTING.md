# Contributing to noeta-agent

Thanks for your interest in improving `noeta-agent`. This project is the
official product built on the [Noeta runtime + SDK](https://github.com/initxy/noeta).
It is a single-user, local-first agent workbench: a FastAPI backend plus a React
SPA shipped as one process.

The canonical working agreement lives in [`AGENTS.md`](AGENTS.md) and the
vocabulary in [`CONTEXT.md`](CONTEXT.md); this file is the contributor-facing
summary.

## Getting started

Prerequisites: **Python 3.12+** with [uv](https://docs.astral.sh/uv/), and
**Node 20+**.

```bash
git clone https://github.com/initxy/noeta-agent && cd noeta-agent
make install    # uv sync + frontend deps
make run        # build the SPA + boot the workbench on http://127.0.0.1:8000
```

With no LLM configured the workbench runs a deterministic offline **mock
provider**, so you can develop and test the whole stack with zero credentials.
See the [Quickstart](docs/tutorials/quickstart.md).

## The standard verbs

Run these from the repo root. They are wrapped behind a `Makefile` so they stay
stable regardless of the tool underneath.

| Verb | Command | What it does |
| --- | --- | --- |
| dev | `make dev` | Hot reload: backend on :8000 + Vite dev on :5273. |
| test | `uv run pytest` | The Python suite (`tests/`). |
| lint | `uv run lint-imports` | The import-linter contract. |
| build | `make web` | Build the SPA into `web/dist`. |
| check | `make check` | **Every automated gate in one command.** |
| e2e | `make e2e-web` | Opt-in Playwright browser suite (mock mode). |

## Definition of done

A change is done when **every acceptance criterion is met and all automated
gates are green** — both required, no exceptions.

- Run `make check` before opening a PR. It runs the Python suite, the web
  typecheck + unit tests, and the import-linter contract, and exits non-zero on
  any failure. Local green means CI green.
- Run `make e2e-web` when your change touches the **SPA↔backend wire** (the
  UI-event translator, session lifecycle, streaming). It is the only gate that
  exercises that path end-to-end and is deliberately outside `check`.
- Update the docs that describe what you changed, and add a `CHANGELOG.md`
  entry under `## [Unreleased]` for any user-visible change.

## How we shape a change

- **Feature work changes behavior; maintenance work changes structure. Never mix
  them in one diff.**
- Prefer existing patterns; keep changes focused; no unrelated refactors.
- A vague request should start from a short spec; a small, well-defined change
  can start directly.
- Code is the single source of truth for "what is." When docs and code
  disagree, trust the code and fix the docs.

## Pull requests

- Branch off `main`, keep the PR scoped to one concern.
- Fill in the PR checklist (`make check` green, changelog entry, docs updated).
- CI runs `make check` plus the `e2e-web` browser suite.

## Reporting bugs & security issues

- Functional bugs: open a [GitHub issue](https://github.com/initxy/noeta-agent/issues).
- Security-sensitive reports: follow [`SECURITY.md`](SECURITY.md) instead of a
  public issue.

---

# 为 noeta-agent 贡献代码

感谢你有意改进 `noeta-agent`。本项目是基于 [Noeta 运行时 + SDK](https://github.com/initxy/noeta)
构建的官方产品：一个单用户、本地优先的 agent 工作台 —— FastAPI 后端加一个
React SPA，作为单一进程发布。

权威的协作约定见 [`AGENTS.md`](AGENTS.md)，术语表见 [`CONTEXT.md`](CONTEXT.md)；
本文件是面向贡献者的摘要。

## 快速开始

前置：**Python 3.12+**（配 [uv](https://docs.astral.sh/uv/)）和 **Node 20+**。

```bash
git clone https://github.com/initxy/noeta-agent && cd noeta-agent
make install    # uv sync + 前端依赖
make run        # 构建 SPA + 在 http://127.0.0.1:8000 启动工作台
```

未配置 LLM 时，工作台运行确定性的离线 **mock provider**，因此你可以零凭证开发
和测试整个栈。参见[快速开始](docs/zh/tutorials/quickstart.md)。

## 标准动词

在仓库根目录运行。它们被封装在 `Makefile` 后面，无论底层工具如何变化，这些动词
都保持稳定。

| 动词 | 命令 | 作用 |
| --- | --- | --- |
| dev | `make dev` | 热重载：后端 :8000 + Vite dev :5273。 |
| test | `uv run pytest` | Python 测试套件（`tests/`）。 |
| lint | `uv run lint-imports` | import-linter 契约。 |
| build | `make web` | 把 SPA 构建到 `web/dist`。 |
| check | `make check` | **一条命令跑完所有自动化门禁。** |
| e2e | `make e2e-web` | 可选的 Playwright 浏览器套件（mock 模式）。 |

## 完成的定义

一个改动算完成，当且仅当**每一条验收标准都满足、所有自动化门禁全绿** —— 两者
都必须，无例外。

- 提 PR 前先跑 `make check`：它运行 Python 套件、web 类型检查 + 单元测试、以及
  import-linter 契约，任一失败即非零退出。本地绿即 CI 绿。
- 当改动触及 **SPA↔后端的线路**（UI 事件翻译器、会话生命周期、流式）时，跑
  `make e2e-web`。它是唯一端到端覆盖这条路径的门禁，且刻意排除在 `check` 之外。
- 更新描述你所改内容的文档，并为任何用户可见的改动在 `CHANGELOG.md` 的
  `## [Unreleased]` 下加一条记录。

## 我们如何塑造一个改动

- **功能性工作改变行为；维护性工作改变结构。绝不在同一个 diff 里混用。**
- 优先复用既有模式；保持改动聚焦；不做无关重构。
- 模糊的需求应从一份简短的 spec 开始；小而明确的改动可直接动手。
- 代码是"是什么"的唯一真相来源。文档与代码冲突时，以代码为准并修正文档。

## Pull Request

- 从 `main` 切分支，PR 聚焦单一关注点。
- 填写 PR 清单（`make check` 全绿、changelog 记录、文档已更新）。
- CI 运行 `make check` 外加 `e2e-web` 浏览器套件。

## 报告 bug 与安全问题

- 功能性 bug：提 [GitHub issue](https://github.com/initxy/noeta-agent/issues)。
- 涉及安全的报告：请按 [`SECURITY.md`](SECURITY.md) 流程，不要走公开 issue。
