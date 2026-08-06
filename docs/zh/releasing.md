# 发布（Releasing）

> 英文版为权威：[`docs/releasing.md`](../releasing.md)。两边不一致时以英文为准。

本仓库只发布**一个**分发物：`noeta-agent` wheel。一个已合并的行为改动之后应当跟一次
发布 —— 已发布的包不应落后于 `main`。

`noeta-agent` 依赖单独发布的 `noeta-runtime` / `noeta-sdk`
库（在相邻的 `noeta` monorepo 中开发）。当某次发布需要一个刚刚随库发布的
运行时/SDK 行为时，在打 tag 之前把 `pyproject.toml` 里的 `>=` 下限抬到携带该行为的
版本。

## 一个 tag 发布什么

一个 `vX.Y.Z` tag 触发 `release.yml`，它把 `noeta-agent` wheel 构建一次，然后跑一个
publish job。**publish job 以 tag 版本为门禁**：只有当构建产出的 wheel 版本等于
`X.Y.Z` 时才上传，否则带一条 notice 跳过。这个门禁防止某个 tag 因为重复上传而失败 ——
比如当某个 tag 并没有为它 bump `noeta-agent` 的版本时（例如一个只为推进相邻库而切的
tag）。

## 版本策略

- **默认 patch**：bug 修复、小的 additive API、打包修复。
- **Minor / major**：由维护者明确决定（feature 级或破坏性发布）—— 不要机械地从 semver
  推导，去问。

## 流程

1. 定范围：确认 `noeta-agent` 源码确实变了。一次源码没变的发布保持当前版本。
2. 更新 `CHANGELOG.md`：把 `## [Unreleased]` 重命名为 `## [X.Y.Z] - <date>`（在其上方保留
   一个新的空 `Unreleased`），并从 `git log vPREV..HEAD` 补全条目 —— 只写经过筛选的、
   用户可见的改动，不是 commit 标题。更新底部的 compare 链接。一个改变行为的 PR *可以*
   直接把条目加进 `Unreleased`；发布 PR 是补齐缺漏的兜底。`release.yml` 拒绝发布一个
   版本没有对应带日期 changelog 段落的 tag。
3. Bump `pyproject.toml` 里的 `version`，如果这次发布依赖某个新发布的库行为，抬高
   `noeta-runtime>=` / `noeta-sdk>=` 下限。
4. 跑 `uv sync` 刷新 `uv.lock`。
5. 通过 CI 全绿的 PR 合并到 `main`。
6. `git tag vX.Y.Z && git push origin vX.Y.Z` —— `release.yml` 构建前端 + wheel，并通过
   PyPI trusted publishing 发布（不存 token）。

## 验证

用 `uv pip install --no-cache noeta-agent==X.Y.Z` 装进一个干净的 venv（JSON API 和
simple index 会比 CDN 慢一两分钟落地），并 import 这次发布改动的那部分表面。然后看
Actions run：publish job 应当显示一次上传，而不是
`no noeta_agent-X.Y.Z wheel — not part of this release; skipping` 那条 notice。那条
notice 意味着第 3 步的版本 bump 漏了。

## 备注

- `noeta-agent` 是 **wheel-only**：它的 wheel force-include 了 `web/dist`，一个被
  gitignore 的 Vite 产物，sdist 够不到。所以前端必须在打包前构建好（`release.yml` 先跑
  `make web`），一个没有事先构建 web 的裸 `uv build` 会因为缺失的 forced include 而失败。
- pypi.org 上的 Trusted-publisher 配置：project `noeta-agent`，Owner `initxy`，
  Repository `noeta-agent`，Workflow `release.yml`，Environment `pypi-agent`（必须与
  `release.yml` 里的 `environment:` key 匹配）。
