# Troubleshooting

Common issues, as **Symptom → Cause → Resolution**. Architectural boundaries
that are *not* bugs live in [Limitations](limitations.md).

## The agent answers with the same scripted demo every time

**Symptom:** `GET /api/v1/health` reports `{"provider": "mock"}` even though you
configured a gateway, and every session plays the same question → file → answer
chain.

**Cause:** `LLM_PROVIDER=auto` resolves to the offline mock unless **both**
`LLM_BASE_URL` and `LLM_API_KEY` are set; one empty value falls back silently.

**Resolution:**

- Set both keys in the `.env` **in the directory you start the process from**.
  Environment variables override the file — check for a stale exported variable
  blanking one.
- `LLM_BASE_URL` is the gateway **root**; the provider appends `/responses`.
- `LLM_PROVIDER=openai` makes the fallback loud: boot fails instead of degrading.

## A model is rejected before the turn starts

**Symptom:** `POST /messages` returns **422** `invalid_model` or
`model_not_allowed`.

**Cause:** The model menu comes from `./models.json`, not from the gateway, and
a model or reasoning effort outside that catalogue is refused synchronously —
deliberately, so a typo never reaches (and never bills) the provider.

**Resolution:** add the model to `models.json` with the exact id your gateway
serves, and list the effort levels it supports. Vendor naming gotchas apply
(Anthropic ids carry a date suffix).

## A long conversation never compacts

**Symptom:** Context grows until the gateway complains, and the transcript shows
no `compaction` frame.

**Cause:** The model is registered with a defaulted or too-small
`context_window`, so compaction triggers too late (or, on a very small window,
behaves as if off).

**Resolution:** declare the real `context_window` and `max_output_tokens` on the
`models.json` entry. A startup warning flags any model still on the default.

## The sandbox tier is missing from the project form

**Symptom:** Creating a project offers only `local`.

**Cause:** `GET /api/v1/health` reported `sandbox_available: false` — a live
`docker version` probe found no daemon (or it timed out).

**Resolution:** start Docker and reload. The probe is cached for 30 s.

## A `sandbox` project behaves as if it were local

**Symptom:** The project's tier says `sandbox`, but files land on the host with
no container and `GET /sessions/{id}/preview` 404s.

**Cause:** With no sandbox provider wired (no Docker at boot), the execution
policy is never consulted and every task runs local. Also: the tier is welded
into a session at its **first turn**, so a session created while the project was
`local` keeps that tier forever.

**Resolution:** make sure Docker is available when the process starts, and
create a **new session** after changing the tier.

## The preview panels never appear

**Symptom:** No Preview / Terminal buttons on a sandbox project.

**Cause:** One of: the project is `local`; the container was never allocated
(no turn has run yet); the idle reaper removed it; or the preview origin could
not bind its port (`port: null` in the discovery payload) — a bind failure costs
the panels, never the conversation.

**Resolution:** run a turn, check the backend log for a bind error, and pin
`SANDBOX_PREVIEW_PORT` when a firewall or tunnel needs a fixed port (the panels
are served from a **second port**; forwarding only the main one is not enough).

## Saving an artifact returns 409

**Symptom:** The editor refuses to save with a conflict offering "Reload theirs"
or "Overwrite with mine".

**Cause:** The file changed on disk since the read that filled the editor —
another session, the agent mid-turn, or your own editor. This is the
optimistic lock working, not a failure.

**Resolution:** pick one. There is no merge, on purpose. If it happens
constantly, you have two live sessions writing the same files — see
[the project model](../adr/project-model.md).

## The session refuses new messages with 409

**Symptom:** `POST /messages` returns **409** `session_busy` or
`not_resumable`.

**Cause:** `session_busy` means a **question is pending** (`waiting`) — answer
it, or Stop. A *running* turn is no longer busy in this sense: a message sent
into it is delivered as a mid-turn steer (`inject_goal`), not refused.
`not_resumable` means the conversation was **cancelled**, which is terminal:
cancel means cancel, and a new conversation is a new session.

**Resolution:** to stop a turn and keep the conversation, use **Stop**
(`interrupt`), not Cancel. If a send is refused with `session_busy`, there is a
question waiting above the composer — answer it.

## A turn ended with `turn_failed`

**Symptom:** An inline notice in the conversation says the turn failed, and the
composer is still enabled.

**Cause:** A provider fault parks the turn instead of sealing the ledger. This
is the designed behaviour and the session is `idle`.

**Resolution:** just send again — an ordinary message resumes the **same** task
with its full context. There is no separate retry verb, on purpose.

## Provider returns 401

**Symptom:** Turns fail with an authentication error from the gateway.

**Cause:** A missing, expired, or unentitled key.

**Resolution:** verify `LLM_API_KEY` (primary) or `SECONDARY_LLM_API_KEY`
(secondary) — both authenticate with `Authorization: Bearer`. Behind a corporate
proxy, set `HTTPS_PROXY`.

## The browser shows a build hint instead of the UI

**Symptom:** A plain-text page saying the web UI has not been built.

**Cause:** No SPA bundle was found — neither the packaged one nor `web/dist`.

**Resolution:** `make web` (or `npm run build` in `web/`) and reload. The API is
live either way; try `/api/v1/health`.

## The editable install looks stale after a big change

**Symptom:** Code you changed under `noeta/agent/**` is not what runs.

**Cause:** `uv` caches the editable build against `pyproject.toml`, not the
package tree, so recreating the package directory can leave an old build in
place. It presents as a packaging bug and is not one.

**Resolution:** `uv sync --reinstall-package noeta-agent`. A clean clone is
unaffected.

## Nothing happens after a skill was added

**Symptom:** A new `SKILL.md` under `<project>/.noeta/skills/` is never
activated.

**Cause:** A workspace's skill registry is resolved when its engine is first
compiled and cached for the process.

**Resolution:** restart the process. (Also: the skill control tool self-gates on
a non-empty menu, so an empty project genuinely has no skill step.)

## See also

- [Known limitations](limitations.md) — boundaries that are not bugs
- [Configuration](../reference/configuration.md) — every key
- [HTTP API reference](../reference/http-api.md) — the full error-code table
