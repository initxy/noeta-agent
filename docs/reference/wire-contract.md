# The wire contract

**Status: normative and frozen.** This is the contract the backend implements
and the client consumes. It outranks every other document in this repository on
the UI-event vocabulary, the SSE contract, the REST surface and the status
machine, including [`http-api.md`](http-api.md), which is a reader's guide to the
same surface. Where any other document differs, this one wins.

**Nobody changes this document unilaterally.** A change that needs a frame, a
field or an endpoint that is not here adds one under the extension rules in §8
and says so in the same change.

---

## 1. Vocabulary

| Term | Is | Is not |
| --- | --- | --- |
| **Project** | one directory on disk + the sessions held against it + the agent config brought to them (persona, default model/effort, execution tier, MCP connectors, memory toggle) | a Space. There is no membership, no sharing, no owner. |
| **Session** | the application-layer unit of conversation — what the sidebar lists, resumes and deletes. Owns **one or more task streams**. | one task id. See §3. |
| **Task stream** | one engine task, with its own `seq` space starting at 0 | a session |
| **Turn** | one user message and everything the agent does until it parks | a message |
| **Branch** | a sibling task stream inside one session, created by `fork` | a new session |

The engine knows only Tasks. "Session" is a product word; every SDK parameter
that looks like it wants a session id wants a **task id**.

All sessions of a project share the project directory as their workspace root.
Two live sessions can therefore conflict on disk. This is accepted and it must be
stated in the project-creation UI. It is also why `rewind` — which restores
files — carries an explicit rollback warning and is offered on root sessions
only: undoing one session can revert files another wrote after the anchor.

---

## 2. The UI event vocabulary

The wire is a **flat UI-event vocabulary**, not raw engine envelopes. Raw
envelopes are a diagnostics surface only (`/api/v1/trace/...`).

```
UIEvent = { seq: int | null, type: string, data: object }
```

`data` always carries `_task` (§3). Every other field is per-type below.

### 2.1 Durable frames (carry a `seq`, are replayable)

Derived by `translate(env, deref, subtask_id=None)` from one `EventEnvelope`.

| type | data | derived from | notes |
| --- | --- | --- | --- |
| `user_message` | `{content, images?}` | `MessagesAppended`, `role=="user"` **and no `origin`** | `content` = all `text_block`s joined by `\n`, stripped. `images` = `[{hash, media_type}]` from `image_block`s, and the key is **attached only when non-empty** — a text-only turn's data is exactly `{content, _task}`. Image bytes never travel the stream. |
| `assistant_text` | `{text}` | `MessagesAppended`, `role=="assistant"`, `text_block` | stripped; empty dropped. **Never clipped.** One frame per text block. |
| `thinking` | `{text}` | `AssistantThinkingRecorded` | deref `thinking_ref`, join blocks with `\n`, **clip 2000**. |
| `recall` | `{text}` | `MessagesAppended`, `role=="user"`, `origin=="memory"` | Auto-recall is recorded as an `origin="memory"` message. Render as a "recalled" chip, never as something the user said. Clip 2000. |
| `tool_call` | `{call_id, tool_name, arguments, subtask_id?}` | `ToolCallStarted` | `arguments` inline, else deref'd. |
| `tool_result` | `{call_id, success, summary, output, subtask_id?}` | `ToolResultRecorded` | `output` deref'd then **clipped 2000**. Suppressed when the paired call folded to `memory_op` (§2.4). |
| `memory_op` | `{call_id, op, name}` | `ToolCallStarted`, `tool_name ∈ {memory_write, memory_read, memory_search, memory_archive}` | `op ∈ write/read/search/archive`. `name` = `arguments["query"]` for search, `arguments["name"]` otherwise. Replaces the generic `tool_call`. |
| `skill_activated` | `{skill}` | `MessagesAppended`, assistant `tool_use_block` with `tool_name == "skill"` | the SDK-level `SKILL.md` mechanism; only a DB registry ever backed it, and that is gone. |
| `todo_update` | `{todos: [{id, content, status}]}` | `TaskStatePatched` where `patch["set_todos"]` is a list | every other patch shape emits **nothing**. |
| `subtask_started` | `{subtask_id, agent_name, goal}` | `BackgroundSubagentStarted` **or** `SubtaskSpawned` | two engine shapes, one UI frame. |
| `subtask_finished` | `{subtask_id, status, summary}` | `BackgroundSubagentDelivered` **or** `SubtaskCompleted` | `status ∈ completed/failed/cancelled`. On `SubtaskCompleted`: failed → `result.error`, else `result.output` **deref'd when it is a ContentRef**. **Not clipped** — it is the subtask's answer. |
| `question` | `{question_id, reason, questions:[{id, question, header, choices:[{id,label,description}], allow_freeform}]}` | `UserQuestionRequested` | deref `questions_ref`, flatten. |
| `question_answered` | `{question_id}` | `UserQuestionAnswered` | |
| `compaction` | `{replaced_count}` | `Compacted` | `CompactionRequested` is deliberately **not** forwarded. Defaults to 0. |
| `rewind` | `{target_seq}` | `TaskRewound` | The engine re-based the stream to before the user message at `target_seq` (that turn and every later one are now dead history, still on the stream). The client folds it into a **truncation**: drop every item keyed past `target_seq`, land live at that boundary. `state_ref` is a server-only fold baseline and never crosses the wire. |
| `llm_retry` | `{call_id}` | `LLMRetryScheduled` | renders **no UI**; its only job is clearing the client's delta buffer for that `call_id` (§6.3). |
| `turn_started` | `{}` | `TaskStarted` **or** `TaskWoken` | |
| `turn_finished` | `{status, reason?}` | see §2.2 | `status ∈ awaiting_input / completed / cancelled / failed / interrupted / turn_failed`. |
| `error` | `{message}` | `TaskFailed` | **clip 500**. Always emitted immediately before `turn_finished{failed}` from the same envelope. |

### 2.2 `turn_finished` — the full mapping

This is the trickiest part of the vocabulary.

On `TaskSuspended`, read the payload's `reason` through
`parse_suspend_reason` and the `wake_on` condition's `__canonical_tag__`:

```
tag ∈ {subtask_group_completed, subtask_completed}  -> emit NOTHING
      (the root is parked on a subtask barrier; the turn is not over)
wake_on.handle starts with "question-"               -> emit NOTHING
      (the `question` frame already expresses that state)
kind == SUSPEND_REASON_INTERRUPTED                   -> turn_finished{interrupted}
kind == SUSPEND_REASON_TURN_FAILED                   -> turn_finished{turn_failed, reason: detail}
otherwise (waiting_human / next-goal / unknown)      -> turn_finished{awaiting_input}
```

An **unknown** suspend kind maps to `awaiting_input`. The runtime's own contract
says the tag is a legibility field a new producer may extend without a protocol
bump — so treat unknown as "parked", never as an error.

The terminal envelopes:

```
TaskCancelled -> turn_finished{cancelled}
TaskFailed    -> error + turn_finished{failed}
TaskCompleted -> turn_finished{completed}
```

**`turn_failed` is resumable and `failed` is not.** A provider 5xx parks the turn
instead of sealing the ledger. The client renders `turn_failed` as an
in-conversation retriable error with the composer **enabled**; the next ordinary
message resumes the same task with full context. There is no "on TaskFailed the
session is dead" branch — for a `multi_turn=True` client, `TaskFailed` on a root
conversation only happens on paths that genuinely terminate.

Corollary, stated because it is easy to miss: **`suspended` does not imply
"everything went fine."** Read the reason before rendering a green checkmark.

### 2.3 Synthetic frames (`seq = null`, **no SSE `id:` line**, never replayed)

| type | data | pushed by |
| --- | --- | --- |
| `delta` | `{call_id, kind: "text"\|"thinking", text, index}` | the delta sink (§6) |
| `replay_done` | `{}` | the SSE endpoint, once, at the end of replay |
| `session_meta` | `{title}` | the title-generation thread |
| `turn_started` | `{}` | the send path, **before** the drive job is queued — instant feedback while `seed_start` blocks on container cold start |
| `error` + `turn_finished{failed}` | | the drive-failure handler, when the drive thread throws outside the engine |
| `branch_created` | `{task_id, source_task_id, message_seq}` | the fork endpoint (§3) |
| subtask-stream `tool_call` / `tool_result` / `subtask_finished` | as above, always with `subtask_id` | the subtask translator (§2.4) |

`replay_done` is the only synthetic frame that appears during replay — it *ends*
replay.

### 2.4 Subtask streams — the narrow vocabulary

When `subtask_id is not None` the translator switches to a deliberately tiny
vocabulary: `ToolCallStarted -> tool_call`, `ToolResultRecorded -> tool_result`,
`TaskCancelled -> subtask_finished{cancelled}`, **everything else -> `[]`**.

Two hard rules, neither of them style:

- **All subtask frames carry `seq = null`.** A subtask's stream counts `seq`
  independently of the parent; carrying it collides with the parent-stream dedup
  and *silently swallows root events*.
- **`TaskCancelled` must be wrapped up here.** On a cancel cascade the subtask
  writes only `TaskCancelled` to its own stream — no `Delivered` reaches the
  parent — so without this branch the subtask card stays "running" forever.

A subtask's `Compacted` must **not** appear in the parent chat.

### 2.5 The two asymmetries the translator fixes

1. **`memory_op` result suppression.** A `memory_*` call folds into `memory_op`,
   and its paired `ToolResultRecorded` must **not** emit a normal `tool_result`
   with the same `call_id` — the client would silently drop it because no step
   matches, but leaving it on the wire is noise. The translator is pure and
   stateless, so it re-derives the decision from the result payload's own tool
   name where the payload carries one; otherwise the client drops an unmatched
   `tool_result` by design.
2. **`workflow_update` does not exist**, along with the workflow feature.

### 2.6 What is not on the wire

`workflow_update`. In particular `_task` **is** on the wire — see §3.

### 2.7 `ts` — the optional server clock

Every **durable** frame's `data` may carry `ts`: the source envelope's
`occurred_at`, epoch seconds as a float. It is **optional** — a consumer that
does not find it must degrade, never fail — and it is meaningless on a synthetic
frame, which no envelope produced.

It exists because the conversation is turn-centric and a finished turn folds its
work behind *"Worked for 1m 35s"*. That label has to be **re-derived from the
log**, exactly like every other thing on the screen: a duration measured by a
browser stopwatch restarts at every reload, so a reloaded transcript would either
lose the label or invent a new one for a turn that finished yesterday. A client
with no `ts` falls back to a step count (`"6 steps"`).

This is an optional field, not a new frame and not a stored projection:
`occurred_at` is already on the envelope, so replay re-derives `ts` with
everything else.

---

## 3. Task identity and branches

**Every frame carries `data._task` = the id of the task stream it belongs to.**
Session-level synthetic frames may omit it; an omitted `_task` reaches every
consumer.

`fork` creates **sibling task streams inside one session**. A session's detail
response therefore lists its task streams, and the SSE endpoint takes an optional
`?task_id=` filter:

```
a frame passes the filter if its _task is absent (session-level) or equals the filter
```

A fork is **not** a new session. `POST /sessions/{id}/fork` appends a task
stream to the same session, emits the synthetic `branch_created`, and the client
switches the `?task_id=` filter to the new stream. Both branches share the
project directory — say so in the UI (`fork` does not restore workspace files;
that is `rewind`, the separate "undo last turn").

---

## 4. The SSE contract

### 4.1 Endpoint and framing

```
GET /api/v1/sessions/{id}/events?since_seq=<int>&task_id=<str>

Content-Type: text/event-stream
Cache-Control: no-cache
X-Accel-Buffering: no          <- required; nginx buffers SSE without it
Connection: keep-alive
```

Frame format, hand-written, not a library:

```
id: <seq>\n            <- OMITTED when seq is null
event: <type>\n
data: <json>\n         <- json.dumps(..., ensure_ascii=False), SINGLE LINE
\n
```

**The field separator is `": "` — key, colon, exactly one space.** Emit `id: 12`,
never `id:12`. The test reader splits on that literal.

**A `delta` frame carries no `id:` line.** With one, the resume cursor advances
past envelopes that never reached the client and a reconnect skips them forever
— silent, permanent data loss. Omitting the id makes loss-on-reconnect a
*format property* instead of a bug class.

### 4.2 Startup order — every step is a bug fix

```
1. q = hub.subscribe(session_id)     # SUBSCRIBE FIRST
2. yield ": connected\n\n"           # FIRST BYTE IMMEDIATELY
3. session = store.get(session_id)   # RE-FETCH, not the request-time snapshot
4. for ev in replay(session, since_seq, task_id): yield frame(ev)
5. yield frame(replay_done)          # synthetic, no id
6. live loop
finally: hub.unsubscribe(session_id, q)
```

1. **Subscribe before replay** or a live event landing in the gap is lost
   forever. The resulting overlap is deduped by `seq`.
2. **Comment frame before anything else.** Buffering proxies (the Vite dev
   proxy, any reverse proxy) wait for the first body byte before forwarding
   response headers, and replay can be slow.
3. **Re-fetch after subscribing.** A client attaching mid-first-turn would
   otherwise replay from a stale snapshot whose `task_id` was bound microseconds
   ago, and the leading events would be lost.

### 4.3 Dedup, heartbeat, disconnect

- `last_seq = since_seq if since_seq is not None else -1`
- in both replay and live: `if ev.seq is not None and ev.seq <= last_seq: skip`,
  else `last_seq = max(last_seq, ev.seq)`. **`seq is null` frames always pass
  through** and never touch `last_seq`.
- heartbeat: `asyncio.wait_for(q.get(), timeout=15.0)`; on timeout emit
  `: ping\n\n`.
- check `await request.is_disconnected()` at the top of every loop iteration;
  always unsubscribe in `finally`.
- **`since_seq = 0` is a FULL replay**, and it is the client's real
  first-connect path. Subtask synthetic frames ride along on it. A reconnect
  with `since_seq > 0` must **not** resend them — they carry no seq, so the
  client cannot dedup them and they would duplicate.

### 4.4 Backpressure

A **bounded** queue per subscription. On overflow drop `delta` frames only;
**never** drop a frame carrying a `seq`. If the envelope queue overflows, close
the stream and let the client reconnect with `since_seq` — re-derivation is
exactly the recovery path.

### 4.5 Read paths never share the drive queue

Replay, raw events, content get/put, file listing and file read all go through
the async thread pool. An active turn can hold a serial worker for minutes (LLM
retries, 120s container command timeouts); parking reads behind it means **every**
session's SSE — including finished ones — never emits `replay_done`, and the
whole frontend hangs on a loading skeleton.

### 4.6 The client reader

Deliberately **not** `EventSource`: it cannot set headers or credentials, cannot
be aborted cleanly, and reconnects on its own schedule with `Last-Event-ID`
semantics the backend does not implement. Use `fetch` + `ReadableStream` + a
hand-rolled parser:

- accumulate decoded chunks, split on `\n\n`;
- per block: lines starting with `:` are skipped; `id:` → `seq = Number(...)`;
  `event:` → type; `data:` lines joined with `\n` then `JSON.parse`d;
- a block with no `event:` or no `data:` is dropped;
- **a `JSON.parse` failure skips that frame and keeps the stream alive** — never
  tear down a connection over one bad frame;
- flush any trailing partial buffer at stream end.

Reconnect, per `(sessionId, taskId)`: one `AbortController`, `attempt` counter,
`delay = min(1000 * 2 ** min(attempt - 1, 3), 8000)` (1s, 2s, 4s, 8s, 8s …).
**`lastSeq` is a ref, not state** — the reconnect closure must read the current
value, not the one captured when the effect ran; getting this wrong replays the
entire session on every reconnect. **A normal stream end is also a reconnect
trigger**, not only an error.

---

## 5. The REST surface

Everything under `/api/v1`. JSON in, JSON out. No auth, no cookies, no CSRF —
the product is single-user and local.

### 5.1 Meta

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/health` | `{status, version, provider, sandbox_available, data_dir}` |
| GET | `/models` | `{models: [{id, label, default, efforts, default_effort}], provider}` — the serialization **excludes** `gateway` / `context_window` / `max_output_tokens`. Stable field order. `provider` is the resolved provider name. |
| GET | `/content/{hash}` | raw bytes, `Content-Type` **sniffed from magic bytes** (the ContentStore has no metadata read interface). 64 hex chars or 404. |

### 5.2 Projects

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/projects` | list |
| POST | `/projects` | `{name, directory, tier, create_directory?}` → 201. `tier ∈ local\|sandbox`. 422 on a non-absolute directory; 409 when the directory is already a project. |
| GET/PATCH/DELETE | `/projects/{id}` | PATCH accepts `{name?, tier?, default_model?, default_effort?, persona?, memory_enabled?}` |
| GET/PUT | `/projects/{id}/agent-config` | persona, default model + effort, memory toggle |
| GET/POST | `/projects/{id}/connectors` | MCP connectors. Every read path **scrubs credential values to sorted name lists** (`header_names` / `env_names`). |
| PATCH/DELETE | `/projects/{id}/connectors/{alias}` | 422 on `McpConfigError` |

**Changing a project's tier only affects sessions created afterwards.** The tier
is welded into `TaskHostBound` at `seed_start` and every later turn fold-resolves
it, so an existing session keeps the tier it was created with. Say this in the
UI rather than pretending the switch is retroactive. (`sandbox_policy` must be
deterministic across resume; the durable weld is what makes it so.)

### 5.3 Sessions

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/projects/{id}/sessions` | list rows |
| POST | `/projects/{id}/sessions` | `{title?}` → 201. Creates a session with **zero task streams**; the first message seeds the first one. |
| GET | `/sessions/{id}` | detail: `{id, project_id, title, status, task_streams: [{task_id, kind, created_at, source_task_id?, branched_at_seq?}], created_at, updated_at}` — plus the index fields the sidebar mutates optimistically (`title_generated`, `pinned`, `archived`, `version`), which every session row carries. The two optional fields are set on a `branch` and null on a `root`; they are the **only durable** record of a fork's lineage, because `branch_created` is synthetic and never replays. |
| PATCH | `/sessions/{id}` | `{title?, pinned?, archived?}` |
| DELETE | `/sessions/{id}` | |
| POST | `/sessions/{id}/messages` | `{text, images?, model?, effort?, skills?, task_id?}` → **202** `{task_id}`. 409 while a turn is running or a question is pending. 422 on an unknown model or an effort outside that model's list — and it must **never reach the provider**. 400 on a bad image (type / base64 / size) with the session left `idle` — *the turn is never seeded*. |
| POST | `/sessions/{id}/answer` | `{question_id, answers}` → 202 |
| POST | `/sessions/{id}/interrupt` | `{task_id?}` → 202. Halts the turn, keeps the conversation. |
| POST | `/sessions/{id}/cancel` | kills the conversation — terminal |
| POST | `/sessions/{id}/fork` | `{task_id, message_seq}` → 201 `{task_id}`. **Same session**, new stream (§3). 409 on `NotForkableError`. |
| POST | `/sessions/{id}/rewind` | `{task_id, message_seq}` → **200** `{task_id}`. Re-bases **this** stream in place (no child session, no navigation) and **restores workspace files** — the truncation arrives as a `rewind` SSE frame. 409 `session_busy` while a turn is running/waiting (undo is a finished-turn action); 409 `not_rewindable` for a bad anchor. |
| GET | `/sessions/{id}/events` | the SSE stream (§4) |
| GET | `/sessions/{id}/files` | `{files: [{path, size, mtime}]}` — reads the **host-side directory directly**, not through the container. Works when the container is stopped. |
| GET | `/sessions/{id}/files/content` | `?path=&mode=text\|raw`. `text` → `{path, content, truncated, mtime}` clipped at 200 KB; `raw` → exact bytes + sniffed `Content-Type`. 400 on an invalid path, 404 on missing. |
| PUT | `/sessions/{id}/files/content` | `{path, content, base_mtime}` → **409 on a mtime mismatch**. |
| POST | `/sessions/{id}/artifacts/resolve` | capped batch; stats through the file surface and overwrites `exists / size / updatedAt / preview`. |
| GET | `/sessions/{id}/preview` | `{token, port, panels}`; **404 when the session has no container** and the client hides the panel. |

`rewind` **is** exposed (as "undo last turn"): it re-bases a stream in place and
restores workspace files, offered on the latest committed user message of a
root session with an explicit file-rollback warning.

### 5.4 Trace

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/trace/sessions/{id}/raw-events` | `?cursor=` — the cursor is a **`{task_id: last_seq}` map**, because each stream counts `seq` independently. Passing it back yields a strict increment. Subtask ids come from those already in the cursor ∪ spawn markers in this round's root increment. Serialized with `envelope_to_dict`. |

Unauthenticated-local: there is no admin gate.

### 5.5 Path containment

Every path parameter that names a workspace file goes through
`resolve_within(root, rel)`: reject empty and absolute paths, and
`os.path.realpath` **both** the candidate and the root before the containment
check. That blocks `../` escapes *and* reads through workspace-internal symlinks
pointing outside — the second is the case a naive check misses.

### 5.6 Error envelope

```json
{"error": {"code": "not_forkable", "message": "…"}}
```

`code` is a stable machine-readable slug; `message` is human text and may
change. HTTP status carries the class (400/404/409/422/500); `code`
disambiguates within it.

---

## 6. Deltas

1. A delta **never enters the EventLog or the ContentStore**. It is a side
   effect of an in-flight LLM call, pushed through `HostConfig.delta_sink`.
2. A delta frame has **no SSE `id:` line** (§4.1).
3. The durable record of the same bytes is always the `MessagesAppended` that
   follows. The final event **repaints** the preview.
4. Deltas may be dropped under backpressure. Envelope frames may never be.
5. Tool-call arguments are **not** streamed — partial argument JSON is
   undecodable.
6. **Only root-task deltas are forwarded.** Subtask streaming is unimplemented;
   drop deltas whose `ctx.task_id` is a known subtask.

The sink runs **inside the LLM round-trip on a worker thread**: never block,
never raise. Sink exceptions are swallowed by the runtime, but do not rely on
that.

### 6.1 Recording invariant

**A streamed exchange and a batch exchange of the same content produce
byte-identical EventLog + ContentStore records.** Pinned by a test.

### 6.2 Mock behaviour

`FakeLLMProvider` does **not** implement `StreamingProvider`, so the mock path
emits **zero deltas**. That is deliberate and load-bearing: it keeps every other
test's expected event stream stable. Exactly one test file swaps in
`FakeStreamingLLMProvider` (from `noeta.sdk.testing`).

### 6.3 Client buffer

One buffered call per session: `{callId, blocks: Map<index, {kind, text}>}`.

- a **different `call_id` replaces the whole state** — this is what discards a
  half-stream abandoned by a retry;
- same `(call_id, index)` with the same `kind` appends; a different `kind`
  replaces;
- returning the **same reference** signals "no change" to React;
- clear on `assistant_text`, `thinking`, `question`, `turn_finished` (any
  status), `error`, and session switch;
- on `llm_retry`, `resetCall(state, call_id)` clears **only when
  `state.callId === call_id`**. The retry re-streams under the same `call_id`;
  without clearing, the old and new half-streams concatenate into garbage.

---

## 7. The status machine

The vocabulary the whole suite depends on is exactly **`idle` / `running` /
`waiting`**, per session, derived from the envelope stream.

```
UserQuestionRequested            -> waiting   (BEFORE the `question` frame is pushed,
                                               so a client can answer immediately)
TaskStarted / TaskWoken          -> running
TaskSuspended, tag ∈ {subtask_group_completed, subtask_completed}
                                 -> running   (a subtask barrier is NOT idle)
TaskSuspended, handle "question-*"
                                 -> waiting
TaskSuspended, otherwise         -> idle
TaskCancelled/Failed/Completed   -> idle, and TERMINAL
```

**A terminal state is absorbing, per `task_id`.** `cancel` emits `TaskCancelled`
on the request thread while the same turn's `TaskSuspended` is emitted by a
worker with no ordering guarantee. A late `TaskSuspended(question-*)` would
otherwise flip an already-terminated turn back to `waiting` and **wedge the
session permanently** — new messages get 409, yet there is no real question to
answer. Track it **per task**, not per session, so cancelling an old task cannot
freeze the session's next task.

The subtask-barrier predicate reads the **canonical tag**, not a `handle` field:
`SubtaskGroupCompleted` has no `handle`, which is exactly what distinguishes it
from a human-response wake. The translator and the status updater must use the
**same** predicate.

---

## 8. Extension rules

Frozen: every frame `type` in §2, the shape of `data` for those types, the SSE
framing and startup order in §4, the paths and status codes in §5, the status
vocabulary in §7.

A change **may**:

- add a **new** frame type, if it declares here whether it is durable or
  synthetic and, when synthetic, why it cannot be derived from the log;
- add an **optional** field to an existing frame's `data`;
- add a new endpoint under an existing resource.

A change **may not**:

- change the meaning or type of an existing field;
- make an optional field required;
- add an SSE `id:` to a synthetic frame;
- put a `seq` on a subtask frame;
- introduce a stored UI-event projection. Replay is re-derivation. Any UI event
  that cannot be derived from the EventLog **must** be synthetic — because it
  will not survive a refresh, and that has to be a conscious choice rather than
  a discovery.

The translator imports **no engine type**. `ContentRef` and wake conditions are
detected by `getattr(value, "__canonical_tag__", "")`, never `isinstance`. That
is what lets the whole vocabulary be unit-tested with `types.SimpleNamespace`,
and what keeps the test surface off the engine's release cadence. Importing the
exported **string constants** (`SUSPEND_REASON_*`, `NEXT_GOAL_WAKE_HANDLE`) is
fine — they are strings, not types.

A translation failure must never block the engine: the call site catches, logs,
and drops **one** envelope.
