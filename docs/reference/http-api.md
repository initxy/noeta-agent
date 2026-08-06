# HTTP API reference

The REST + SSE surface served by `python -m noeta.agent`. Every route below is
prefixed **`/api/v1`** (omitted from the tables). JSON in, JSON out.

> **The normative document is
> [`docs/reference/wire-contract.md`](wire-contract.md).** It
> freezes the UI-event vocabulary (§2), the SSE framing and startup order (§4),
> the REST paths and status codes (§5) and the session status machine (§7), and
> it states the rules for extending any of them (§8). This page is the reader's
> guide to the same surface; where the two disagree, the contract wins and this
> page is the bug.

**There is no auth.** No cookies, no CSRF, no admin gate: the product is
single-user and local, and it is not meant to be exposed on a network. The
`Host` binding defaults to `127.0.0.1` for that reason.

**Command endpoints ack with 202** and a small body; everything visible arrives
on the session's SSE stream.

**Credentials never round-trip.** MCP connector headers and env values are
stored server-side; every read path answers with sorted **names** only.

## Errors

Every error is the same envelope (§5.6):

```json
{"error": {"code": "not_forkable", "message": "…"}}
```

`code` is a stable machine-readable slug; `message` is human text and may
change. The HTTP status carries the class, `code` disambiguates within it. An
unrouted `/api/v1/*` path answers `404 unknown_endpoint` in the same shape.

| Status | Codes you will actually see |
| --- | --- |
| 400 | `invalid_path`, `invalid_mode`, `invalid_image`, `invalid_cursor`, `write_failed` |
| 404 | `unknown_project`, `unknown_session`, `unknown_task_stream`, `unknown_file`, `unknown_content`, `no_preview`, `unknown_endpoint` |
| 409 | `session_busy`, `duplicate_directory`, `duplicate_alias`, `no_task_stream`, `not_forkable`, `not_rewindable`, `not_resumable`, `task_terminal`, `file_conflict` |
| 422 | `invalid_directory`, `invalid_model`, `model_not_allowed`, `empty_message`, `invalid_answer`, `file_too_large`, `mcp_config` |
| 503 | `engine_unavailable` |

`file_conflict` carries one **optional** extra field, `current_mtime`, so the
"overwrite theirs" path costs no extra read.

## Meta

| Method & path | Purpose |
| --- | --- |
| `GET /health` | `{status, version, provider, sandbox_available, data_dir}`. `provider` is the *resolved* provider (`mock` or `openai`). `sandbox_available` is a live, cached, off-loop `docker version` probe — advisory only: it does not gate a project's stored tier. |
| `GET /models` | `{models: [{id, label, default, efforts, default_effort}], provider}`. The serialization **excludes** the backend-only fields `gateway` / `context_window` / `max_output_tokens`. |
| `GET /content/{hash}` | Raw ContentStore bytes by SHA-256 hash (64 hex chars, else 404). `Content-Type` is **sniffed from magic bytes**. This is how a user bubble re-renders an attached image: bytes never travel the event stream, only the hash does. |

## Projects

A project is one directory on disk plus the configuration the agent brings to
the sessions held against it.

| Method & path | Purpose |
| --- | --- |
| `GET /projects` | `{projects: [row]}`. |
| `POST /projects` | `201`. Body `{name, directory, tier, create_directory?}`; `tier ∈ local\|sandbox`. **422** on a relative path or a directory that is not there (unless `create_directory`), **409** when the directory already belongs to a project. |
| `GET /projects/{id}` | One row. |
| `PATCH /projects/{id}` | `{name?, tier?, default_model?, default_effort?, persona?, memory_enabled?}`. |
| `DELETE /projects/{id}` | `204`. Cascades to sessions, task streams and connectors. **Never touches the directory.** |
| `GET/PUT /projects/{id}/agent-config` | `{persona, default_model, default_effort, memory_enabled}` as one document. |
| `GET/POST /projects/{id}/connectors` | MCP connectors. Reads answer `{…, header_names, env_names, …}` — never credential values. |
| `PATCH/DELETE /projects/{id}/connectors/{alias}` | Edit / remove. `422 mcp_config` on a spec the SDK refuses. |

A project row is
`{id, name, directory, tier, persona, default_model, default_effort,
memory_enabled, version, created_at, updated_at}`. `version` is the monotonic
counter the client's optimistic-mutation protocol resolves last-writer-wins by.

> **Changing `tier` only affects sessions created afterwards.** The tier is
> welded into the task at `seed_start` and every later turn resolves it from
> there. See [execution-tier-per-project](../adr/execution-tier-per-project.md).

## Sessions

A session owns **one or more task streams**: it is created with none, the first
message seeds the first, and every `fork` appends a sibling. That is why the
verbs take an optional `task_id` and the detail response lists the streams.

| Method & path | Purpose |
| --- | --- |
| `GET /projects/{id}/sessions` | `{sessions: [row]}`. |
| `POST /projects/{id}/sessions` | `201`, answering with the detail shape. Body `{title?}`. Creates a session with **zero task streams** — no engine task, no container and no workspace assembly until somebody actually says something. |
| `GET /sessions/{id}` | The row plus `task_streams: [{task_id, kind, source_task_id, branched_at_seq, created_at}]`. The two lineage fields are set on a `branch` and null on a `root`, and they are the **only durable** record of a fork — `branch_created` is synthetic and never replays. |
| `PATCH /sessions/{id}` | `{title?, pinned?, archived?}`. |
| `DELETE /sessions/{id}` | `204`. Removes the conversation index; **keeps the project directory and the event log's trace**, and never releases the project's container (a sibling session may still be in it). |
| `POST /sessions/{id}/messages` | **202** `{task_id}`. Body `{text, images?, model?, effort?, skills?, task_id?}`. |
| `POST /sessions/{id}/answer` | **202**. Body `{question_id, answers, task_id?}`. |
| `POST /sessions/{id}/interrupt` | **202**. Body `{task_id?}`. Halts the turn, keeps the conversation. |
| `POST /sessions/{id}/cancel` | **202**. Kills the conversation — **terminal**; a later message on that stream is `409 not_resumable`. |
| `POST /sessions/{id}/fork` | **201** `{task_id}`. Body `{task_id, message_seq}`. **Same session**, new stream. `409 not_forkable` when there is no prior turn to branch from. |
| `POST /sessions/{id}/rewind` | **200** `{task_id}`. Body `{task_id, message_seq}`. Re-bases **this** stream in place and **restores workspace files** (no child session); the truncation arrives as a `rewind` SSE frame. `409 session_busy` while a turn is running/waiting; `409 not_rewindable` for a bad anchor. |
| `GET /sessions/{id}/events` | The SSE stream (below). |
| `GET /sessions/{id}/files` | `{files: [{path, size, mtime}]}` — the project directory, read **host-side**, so it works on the `local` tier and while a container is stopped. |
| `GET /sessions/{id}/files/content` | `?path=&mode=text\|raw`. `text` → `{path, content, truncated, mtime}` clipped at 200 KB; `raw` → exact bytes with a sniffed `Content-Type`. |
| `PUT /sessions/{id}/files/content` | `{path, content, base_mtime}` → the same body a `GET` would return. **409 `file_conflict`** on an mtime mismatch. |
| `POST /sessions/{id}/artifacts/resolve` | `{paths}` → `{artifacts: [{path, exists, size, updatedAt, preview}]}`, capped at 80, `path` echoed **verbatim**. |
| `GET /sessions/{id}/preview` | `{token, port, panels}`; **404 `no_preview`** when the session has no running container, and the client hides the panels. |

A session row is
`{id, project_id, title, title_generated, status, pinned, archived, version,
created_at, updated_at}`, with `status ∈ idle | running | waiting`.

`rewind` **is** exposed (as "undo last turn"): it re-bases a stream in place
and restores workspace files. Because all sessions of a project share one
directory, undo can revert files another session wrote — so it carries an
explicit rollback warning, is offered on the latest committed user message of a
root session only, and is refused while a turn is running.

### The three stop-shaped verbs are not interchangeable

- **`interrupt`** halts the in-flight turn; the conversation stays alive and the
  next ordinary message resumes the same stream with full context.
- **`cancel`** ends the conversation. Terminal, not resumable.
- **`fork`** writes nothing to the source stream — it appends a sibling to the
  same session, which is why it answers with a task id and not a session id.

### Refusals on `POST /messages`, in the order they are checked

1. **409 `session_busy`** while a **question is pending** (`waiting`), or the
   conversation is terminal (`not_resumable`). A **running** turn is *not*
   refused: the message is injected into it as a mid-turn steer (`inject_goal`),
   delivered at the turn's next boundary and surfaced as an ordinary
   `user_message`. A steer takes no per-turn `model` / `effort` / `skills` — it
   rides the live turn's binding.
2. **400 `invalid_image`** on a bad attachment — with the session unchanged and
   the turn **never seeded**.
3. **422** on an empty message with no attachment (`empty_message`), or a model
   or effort outside the configured catalogue (`invalid_model` /
   `model_not_allowed`) — which never reaches the provider.

This is also the retry path for a failed turn, deliberately not a special one:
`turn_failed` parks the turn instead of sealing the ledger, so the session is
`idle` and an ordinary message resumes it.

### Image attachments

`images: [{media_type, data_base64}]`. MIME allowlist `png` / `jpeg` / `gif` /
`webp`, valid base64, ≤ 5 MB each; a violation is **400** and the turn is never
seeded. Bytes go into the content-addressed store and ride the user turn as
`ImageBlock`s; the UI event carries `{hash, media_type}` and the client renders
them back through `GET /content/{hash}`.

## The SSE stream

```
GET /sessions/{id}/events?since_seq=<int>&task_id=<str>
```

One stream per session, `text/event-stream`. Frames are hand-written:

```
id: <seq>            <- OMITTED when seq is null
event: <type>
data: <json>         <- single line
```

The field separator is `": "` — key, colon, exactly one space.

- **Durable frames carry a `seq` and replay.** Synthetic frames carry no `seq`,
  **no `id:` line**, and never replay.
- **Replay is re-derivation.** On connect the backend replays the session's
  EventLog through the same translator the live path uses, skipping
  `seq <= since_seq`, then emits a synthetic `replay_done` and switches to live
  (deduped by seq across the overlap). There is no stored UI projection.
  `since_seq = 0` is a **full** replay and is the normal first connect.
- **`?task_id=` filters by stream**: a frame passes when its `data._task` is
  absent (session-level) or equal to the filter.
- Heartbeat is a `: ping` comment every 15 s of silence.

Durable vocabulary — `user_message`, `assistant_text`, `thinking`, `recall`,
`tool_call`, `tool_result`, `memory_op`, `skill_activated`, `todo_update`,
`subtask_started`, `subtask_finished`, `question`, `question_answered`,
`compaction`, `llm_retry`, `turn_started`, `turn_finished`, `error` — and
synthetic — `delta`, `replay_done`, `session_meta`, `branch_created`, plus
subtask-stream `tool_call` / `tool_result` / `subtask_finished`. Every frame's
`data` carries `_task`; every durable frame's `data` also carries an optional
`ts` (the source envelope's `occurred_at`, epoch seconds).

**Per-field meanings, clipping rules and the full `turn_finished` mapping are in
the wire contract §2 and are not restated here** — a second copy of a frozen
vocabulary is a second copy to get wrong.

Two rules worth repeating because breaking either is silent:

- **A `delta` frame carries no `id:` line.** With one, the resume cursor would
  advance past envelopes that never reached the client, and a reconnect would
  skip them forever.
- **Subtask-stream frames carry no `seq`.** A subtask counts `seq`
  independently; carrying it collides with the parent-stream dedup. (Frames
  *named* `subtask_*` that are derived from the **root** stream are ordinary
  durable frames and do carry the root's seq.)

## Trace

| Method & path | Purpose |
| --- | --- |
| `GET /trace/sessions/{id}/raw-events` | `?cursor=` — untranslated `EventEnvelope`s for the session's streams and their subtask trees, time-ordered. |

The cursor is a **`{task_id: last_seq}` JSON map**, echoed by each response,
because every stream counts `seq` independently; passing it back yields a strict
increment. Subtask streams are discovered from spawn markers in the same round
that announced them. This is the **only** place raw envelopes cross the wire —
a diagnostics surface, not the product contract.

## Path containment

Every path parameter naming a workspace file is resolved with `resolve_within`:
empty and absolute paths are rejected, and **both** the candidate and the root
are `realpath`-ed before the containment check — which is what blocks `../`
escapes *and* reads through a workspace-internal symlink pointing outside.

## See also

- [The wire contract](wire-contract.md) — normative
- [Product reference](noeta-agent.md) — architecture and boot modes
- [Configuration](configuration.md) — every `.env` key
