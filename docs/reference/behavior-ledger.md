# Behavior ledger — invariants the code must honour

This document records the **behaviours the current code guarantees**, many of
them pinned by tests that cite the section and row numbers below. Read it before
you change the translator, the SSE path, the sandbox seam, the preview gateway
or the provider wiring: the numbered rows in §9 are a regression ledger — a test
holds each one, and a change that breaks a row breaks a named test, so the
numbers are load-bearing and must not be renumbered. §5–§6 describe the sandbox
container lifecycle and the preview panels; §10 collects the traps the code is
shaped around.

The **code is the authority on what is** — where this document and the code
disagree, the code is right and this file is the bug. The normative statement of
the frontend↔backend wire is [`wire-contract.md`](wire-contract.md), not this
file; the vocabulary is [`CONTEXT.md`](../../CONTEXT.md).

---

## 5. The sandbox container lifecycle

### 5.3 The two-stage idle reaper

A daemon thread polls at `max(check_interval_hours * 3600, 60.0)` seconds — a **one-minute
floor**, so a tiny configuration cannot busy-spin.

For every session that has a task: reap only when `status == "idle"` and
`now - updated_at` exceeds a threshold. `waiting` (a question is pending) and `running`
(including a subtask barrier) are **never** reaped — otherwise answering would wait for a
container to come back up.

- **Level 1 — stop** (default 1h): `docker stop`. Processes die, memory and CPU return to
  the host (the entire point of reclamation), but the container body, its write layer, its
  mounts and **its port mappings** all remain. Resume goes through `attach`, which
  `docker start`s it back as-is, in seconds, with in-container state intact.
- **Level 2 — remove** (default 24h): `docker rm`, reclaiming disk. After this the session
  can never attach again. Checked **first** in the sweep, so a very old session removes
  rather than stopping.
- Threshold `<= 0` disables that level. Both disabled = no reaper thread at all.
- Both levels are idempotent (incomplete refcounts after a restart, or a container already
  removed by the deletion path, are both safe). A failure on one session never blocks the
  others; a failed tick never kills the thread.

**Why level 1 must not remove:** a container gets its `SandboxSpec` (mounts, env, resources)
only at the `docker run` moment. `attach` only ever has the `exec_env_ref` — **once removed
it cannot be rebuilt.**

### 5.4 The port-reservation trap (this one is subtle and expensive)

A **stopped** container binds no port, so a `bind(0)` probe cannot see it — but
`docker start` restores its original mapping exactly. Hand that port to a new container and
the stopped session **can never come back up**.

So `allocate` must exclude reserved ports:

- enumerate `docker ps -a --filter name=noeta-sbx- --format {{.Names}}` (`-a`: stopped ones
  count);
- `docker inspect -f "{{range $p, $conf := .HostConfig.PortBindings}}{{range $conf}}{{.HostPort}} {{end}}{{end}}" <names…>`.
  **`HostConfig.PortBindings`, not `docker port`** — the latter reads
  `NetworkSettings.Ports`, which is empty the moment a container stops. `PortBindings` is
  the static config laid down by `docker run -p` and is exactly what `docker start` restores;
- retry the pick 10 times, then raise clearly rather than silently squatting;
- a failed docker query means "nothing reserved" — better an unlikely collision than one
  docker hiccup blocking every allocate.

---

## 6. Sandbox-backed panels — what the Artifact panel sits on

### 6.1 Discovery

`GET /api/v1/sessions/{id}/preview` → `{token, port, panels}`; **404 when the session has no
container** (disabled / not yet allocated / already released) and the frontend hides the
panel. It may trigger a docker lookup, so it runs off the event loop.

Panel sub-paths, pinned against the live AIO image — **each quirk is real**:

```
browser : vnc/index.html?autoconnect=true&resize=scale&path=sandbox-preview/<token>/websockify
terminal: terminal          <- NO trailing slash
code    : code-server/      <- WITH trailing slash
```

- **browser** needs the explicit `path=` because the container serves websockify at the root
  `/websockify`, and noVNC's default absolute path would escape the token prefix.
- **terminal** must have no trailing slash: the page resolves its PTY WebSocket *relative to
  the URL*, and only `.../terminal` resolves onto `<prefix>/v1/shell/ws`.

Full URL: `http://<same hostname>:<port>/sandbox-preview/<token>/<sub>`.

### 6.2 Origin isolation — a reversal you must not undo

The preview runs on **its own port**, served by a deliberately **blank origin**: nothing but
`/sandbox-preview/*`, no cookies, no API, no SPA. The blankness *is* the security property.

Why: these panels need `allow-same-origin` on the iframe (noVNC uses `localStorage`,
code-server registers a service worker). An iframe with `allow-same-origin` is same-origin
with whatever serves it — so serving them from the main port would hand a compromised
container's JS the main API origin, its cookies, and the control plane.

Note this **reverses** an earlier single-port app-preview approach, which relied on
`sandbox="allow-scripts"` *without* `allow-same-origin` (opaque origin). That works for
plain model-written HTML; it does not work for noVNC/code-server. If a generic HTML app
preview is re-introduced, the single-port + opaque-origin trick is still the right answer
for *that* case — the two mechanisms coexist for a reason.

A bind failure on the preview port must **not** block the main agent path: log it, leave the
discovery payload without a port, frontend hides the panels.

### 6.3 The gateway

- Registry: `token -> {session_id, base_url, auth, roots: set}`. Token is
  `secrets.token_urlsafe(16)` — unguessable. `auth` is a **fetch-fresh callable**
  (`connect_headers()`), so a rotated secret is picked up per request and the secret rides
  only the gateway→container leg, never reaching the browser.
- Mount limit 64, evicting the oldest (dict insertion order).
- `mount_root(root_task_id, session_id, base_url, auth)` on the allocate lifecycle hook:
  idempotent when `base_url` is unchanged (token reused); a changed base_url (rebuilt
  container on a new port) mints a new token and invalidates the old.
- `mount_session(...)` is the **lazy fallback**: after a process restart, requeued tasks go
  through `attach`, which fires **no** allocate listener — so when discovery finds no mount,
  look the live handle up from the provider and re-mount.
- `release_root(root, session_id=…)` decrements; only the session's last root unmounts.
  `unmount_session(session_id)` force-unmounts (deletion path).

**HTTP passthrough** `/sandbox-preview/<token>/<sub>[?query]` → `<base_url>/<sub>[?query]`:

- Dropped request headers: `host, content-length, connection, keep-alive, proxy-connection,
  transfer-encoding, te, trailer, upgrade, accept-encoding, origin, referer, cookie`.
- Auth headers injected fresh per request.
- Unknown token → `404 unknown preview token`. Unreachable upstream → `502
  {"error":"sandbox unreachable"}`. Timeout 30s.
- **No CORS headers** — the preview has its own origin, so every fetch a panel makes is
  same-origin from the browser's point of view.

### 6.4 The WebSocket reverse proxy

Protocol: the same path with `Upgrade: websocket`. The proxy implements the smallest useful
subset of RFC 6455 (~200 lines, stdlib only, zero third-party deps).

**The ordering rule that matters most: dial the upstream leg BEFORE sending the 101.** An
unreachable container must surface to the client as a real HTTP error, not a 101 followed by
an abrupt close — noVNC and xterm.js get no close frame from that and cannot tell what
happened. After a successful handshake the handler must write **no further HTTP response**.

- Handshake: `Sec-WebSocket-Accept = base64(SHA1(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))`.
  The 101 is built by hand and written to the raw socket — not via the framework's
  `send_response`, which would add a `Content-Length`.
- Subprotocol negotiation: we support them all, so the negotiated protocol is the first in
  the client's list, and it is **precomputed before the upstream dial** so both legs agree.
- Pass the **raw request target with the query intact** — the terminal PTY WS carries
  `?session_id=…` which must reach the container.
- Pump: two daemon threads forwarding `(fin, opcode, payload)` **verbatim**. Downstream
  (container→browser) writes unmasked; upstream (browser→container) writes **masked** (RFC
  6455 §5.3 requires client frames to be masked). A close frame breaks both legs; `finally`
  does a best-effort `shutdown(SHUT_RDWR)` on both sockets to unblock the sibling thread.
- Deliberately transparent: **no** `permessage-deflate`, **no** UTF-8 validation, control
  frames forwarded unchanged. Full compliance would invite more bugs than it fixes.
- **Bound the declared payload length before allocating** (64 MiB cap; a full-frame raw VNC
  update at 1920×1080×4 is ~8 MiB). A malicious or corrupt declaration would otherwise grow
  host memory until it falls over.
- Socket tuning: `SO_SNDTIMEO` 30s on the **send side only** — the read side must stay fully
  blocking, because an idle-but-healthy panel (a VNC session nobody is touching)
  legitimately goes minutes between frames. TCP keepalive 60/10/3 reaps peers that vanished
  without a FIN. Every option is individually best-effort (test doubles are `AF_UNIX`
  socketpairs where TCP options do not apply); `SO_SNDTIMEO` is skipped on Windows
  (`struct timeval` vs DWORD).
- `ThreadingHTTPServer` with `daemon_threads = True`; the pump runs **synchronously on the
  handler thread** — that is the correct ownership model, the thread is held as long as the
  socket lives.

---

## 9. Behaviors pinned by tests — regression traps

Every item below is currently held by a test. Change the code so a row no longer holds and
its test fails. Items marked **[R]** are explicit regressions for a named past defect.

### 9.0 The test harness itself (do not rebuild this by trial and error)

- **SSE tests run against a real uvicorn**, not starlette's `TestClient` — `TestClient`
  does not truly stream response bodies, the SSE endpoint is an infinite stream, and
  consuming it synchronously blocks forever. The harness boots uvicorn on `127.0.0.1:0`
  in a daemon thread with `lifespan="on"`, polls up to 15s for the port, and reads it back
  off the bound socket.
- **The SSE field separator is `": "` — key, colon, exactly one space.** The test reader
  splits on that literal. Emit `id: 12`, not `id:12`.
- The reader treats a blank line as the frame terminator, skips lines starting with `:`
  (heartbeats), requires `data:` to be **single-line JSON**, and fills `seq = None` for
  frames with no `id:` line. On read timeout it **returns what it has** rather than raising,
  so a test that expects a stop event and gets nothing fails on content, not on a timeout
  traceback.
- **`Settings` is constructed and injected, never read from a file.** An autouse fixture
  strips every settings / ambient / retired env key out of the environment, so no test
  inherits the developer's `.env`; `make_settings` builds a `Settings(_env_file=None, …)`
  from a fixed baseline: `llm_provider="mock"` with empty gateway keys, the **secondary
  gateway keys cleared explicitly** (a developer machine may have a real one, and routing
  behaves differently when it is present), `data_dir` under a `tmp_path` (so the suite
  passes on a second consecutive run), `models_config` pinned to the checkout's
  `models.json`, and `memory_consolidation=False` (the first turn boundary is immediately
  due, so leaving it on would spawn a background curation task in *every* test).
- `wait_status` polls the session detail endpoint every 50 ms with a 15s default. The status
  vocabulary the whole suite depends on is exactly `idle` / `running` / `waiting`.

### 9.1 Translator (unit, no engine)

1. **`MessagesAppended` fan-out order**: one envelope with user text + assistant text +
   a `skill` tool_use block emits exactly `[user_message, assistant_text, skill_activated]`,
   **all with the same `seq`**. A `role="tool"` message in the same body emits nothing.
2. **`ask_user_question` tool_use blocks are not forwarded** from the message body — only
   `skill` is.
3. **Origin-tagged user messages emit nothing.** Pinned specifically for the
   `<background-subagent .../>` completion notice, which would otherwise appear in the chat
   as a message the user "sent".
4. **Clipping boundaries**: tool output clipped at 2000 with a `"… (truncated; N characters
   total)"` suffix; `assistant_text` and subtask summaries **never** clipped (a 1200-char
   subtask result comes through whole); `error` clipped at 500.
5. **`TaskSuspended` triage**, four cases pinned: `handle="question-…"` → `[]`;
   `handle="…next-goal"` → `turn_finished{awaiting_input}`; `__canonical_tag__ =
   subtask_group_completed` → `[]`; `subtask_completed` → `[]`.
6. **`SubtaskCompleted.output` as a ContentRef must be deref'd.** *Explicit defect
   regression*: `_as_text` was once applied to the ref directly, so the card's result section
   showed the literal string `ContentRef(hash=…)` instead of the subtask's answer. A small
   inline string output must skip deref and pass through unchanged.
7. **`TaskStatePatched` without a `set_todos` key emits nothing** — the same envelope also
   carries skill activation and other patches.
8. **Memory folding**, all four ops pinned with the exact `name` source (`query` for search,
   `name` for the rest).
9. **`Compacted` → `compaction{replaced_count}`; `CompactionRequested` → nothing;
   `Compacted` inside a subtask stream → nothing** (a subtask's compaction must not appear in
   the parent chat).
10. **Subtask stream vocabulary**: `tool_call`/`tool_result` carry `subtask_id` and
    **`seq is None`**; `TaskCancelled` → `subtask_finished{cancelled, summary:""}`;
    `TaskStarted` / `TaskCompleted` / `MessagesAppended` all → `[]`.
11. **Out-of-vocabulary envelopes return `[]`** (`LLMRequestStarted`, `ContextPlanComposed`).

### 9.2 Streaming

12. Delta frames arrive on the live SSE **before** the durable `assistant_text`, each with
    `seq is None`, and `data` keys exactly `{call_id, kind, text, index, _task}`.
13. **All deltas of one call share one `call_id` and one `index`, and their concatenation
    equals the durable text exactly.**
14. **A reconnect with `since_seq` replays zero deltas** and still terminates with
    `replay_done`.
15. The SSE stream must be open **before** the message is sent, or no delta is observed —
    deltas are pushed only to online subscribers of a running turn. (This is a property of
    the design, and the test documents it so nobody "fixes" it by buffering.)

### 9.3 API flow

16. **409 on a concurrent send** while a turn is running or a question is pending.
17. **A pending question produces no `turn_finished`** — so the first `turn_finished` after
    an answer is genuinely the end of that turn.
18. **`since_seq` replay is exactly the suffix of the full stream**: same seqs, same types,
    in the same order.
19. **`since_seq = 0` is a FULL replay**, not an incremental one — and it is the frontend's
    real first-connect path. Subtask synthetic steps ride along on it. A reconnect with
    `since_seq > 0` must **not** resend them (they carry no seq, so the client cannot dedup,
    and they would duplicate).
20. **Cancel → continue**: cancelling a session with a pending question yields
    `turn_finished{cancelled}`; the next message starts a **fresh task** on the same
    workspace and the conversation continues.
21. **Cancel cascades to background subagents**: the root's `turn_finished{cancelled}`
    arrives first, then the subtask's `subtask_finished{cancelled}`.
22. **Raw-events cursor semantics**: the cursor is a `{task_id: last_seq}` map (each stream
    counts seq independently); passing it back yields a strict increment; subtask ids come
    from those already in the cursor ∪ spawn markers in this round's root increment.
    *Explicit defect regression*: it once read only the root stream, so clicking a subagent
    on the trace page showed nothing.
23. **`/content/{hash}` is gated on any authenticated user, not admin** — the chat bubble
    needs it to render image attachments. 64 hex chars or 404.
24. **Model config fallback**: with `models.json` missing, `/models` returns the single
    fallback model and sessions can still be created.
25. **`effort` flows through to the provider's `LLMRequest.effort`**; an unsupported effort
    is 422 and **never reaches the provider**.

### 9.4 Status machine (unit-tested directly, because the interleaving is a lottery)

26. **[R] A late `TaskSuspended` after a terminal state must not resurrect `waiting`.** The
    full defect chain, worth reading twice: worker emits `UserQuestionRequested` → `waiting`;
    the client sees waiting and posts `/cancel`; the **request thread** emits `TaskCancelled`
    directly → `idle`; the client sees idle and posts a new message; the **worker thread's**
    late `TaskSuspended(handle="question-…")` arrives and flips back to `waiting`; the new
    message is judged busy → **409**. The observable symptom was
    `test_cancel_then_continue` flaking with `409 != 202`, and the session then being stuck
    in `waiting` forever with no real question to answer. Pinned as: after `TaskCancelled`,
    `TaskSuspended(question-*)` leaves the status `idle`.
27. **[R] Late `TaskStarted` / `TaskWoken` after a terminal state must not resurrect
    `running`** either.
28. **[R] The absorbing state is keyed per task_id, not per session.** `TaskCancelled` on the
    old task must not stop `TaskStarted` on the new task from setting `running` — that is
    exactly the second half of cancel-then-continue.
29. **[R] A subtask barrier keeps the session `running`.** `TaskSuspended` with
    `wake_on.__canonical_tag__ ∈ {subtask_group_completed, subtask_completed}` → status stays
    `running`. Before the fix the code looked for a `handle` field, which that condition
    **does not have**, so it fell through to `idle` *and* the translator emitted
    `turn_finished` — a fake completion while the subagent was still executing, with the
    composer unlocked.
30. **[R] …and the over-broad fix is guarded too**: `handle="noeta-code-next-goal"` must still
    yield `idle`, and `handle="question-c1"` must still yield `waiting`.

The handle/tag vocabulary pinned across these tests, in full:
`"question-*"` → waiting · `"noeta-code-next-goal"` → idle ·
tag `subtask_group_completed` / `subtask_completed` → running.

### 9.5 Concurrency (the expensive ones)

31. **[R] A cancelled waiter must not kill the worker thread.** Chain: the awaitable is
    cancelled → the underlying concurrent future enters CANCELLED (it never went through
    `set_running`, so it is always cancellable) → when the worker finishes, `set_result`
    raises `InvalidStateError`. The old implementation had no guard, the worker thread died,
    and **every subsequent job hung forever**.
32. **[R] Content reads must not queue behind the drive worker.** An active turn holds the
    worker; queued content reads mean trace-page derefs hang until the turn ends. Pinned by
    filling the queue with a 3s sleep and asserting the read returns inside 1.5s.
33. **[R] Replay and raw-events must not queue behind the drive worker.** An active turn can
    hold the worker for minutes (LLM 429 retries, 120s sandbox command timeouts); queued
    replay means **every** session's SSE — including finished ones — never emits
    `replay_done`, and the whole frontend hangs on a loading skeleton.
34. **Delete removes the workspace directory** and the session 404s afterwards, while the
    engine's trace data is deliberately preserved.

### 9.6 Title generation

35. **Generated exactly once**, at first-turn end, asynchronously; a second turn boundary
    must not trigger a second LLM call (the persisted flag guards it).
36. **`session_meta` must not appear in a replay** — asserted explicitly.
37. **The generator receives the raw user goal**, not a cleaned or truncated one, plus the
    task id.
38. **Two different caps, do not conflate them:** the cleaned LLM title is capped at **16
    characters**; the synchronous fallback title is the first line of the message capped at
    **40 characters**.
39. Cleanup rules pinned by example: `"Platform report"` unquoted; `《Tracking plan》。` →
    `Tracking plan` (CJK brackets and full-width period stripped); a two-line title folds to
    one space-joined line (models occasionally emit multiple lines); a punctuation-only
    string cleans to `""` → treated as failure.
40. **A failed generation leaves the fallback title in place and does not set the
    persisted flag**, so a later process can retry.

### 9.7 Sandbox provider

41. **The API key value never enters the `docker run` argv.** Asserted three ways: the argv
    contains `-e SANDBOX_API_KEY` (name only), no token contains the secret, and the secret
    rides in the subprocess `env`.
42. **Verb ordering:** the first docker verb is `inspect` (the liveness probe that decides
    the reuse path), and the last two are `rm` then `run` (best-effort removal of a stale
    same-name container before starting).
43. **A never-ready allocate raises *and* reaps** the half-started container.
44. **A never-ready restart raises and stops the container back** — never `rm`, so the next
    attach can retry. A failed `docker start` likewise leaves the container in `stopped`.
45. **`attach` on an absent container raises with a message naming the cross-host
    limitation**; a ref with no sandbox id raises separately.
46. **Container naming by session + reuse:** two root tasks resolving to the same owner yield
    the same handle and exactly **one** `docker run`.
47. **Refcounted release:** releasing the first root leaves the container running; the second
    removes it. `force_release` by owner id ignores the refcount, and later per-root releases
    must still be no-ops rather than errors.
48. **After a process restart the port is recovered via `docker port`, not re-picked** — a new
    provider instance with a different port picker still yields the original base URL and
    issues no second `run`.
49. **`stop_idle` keeps the container body and its port mapping**, returns `True` only when it
    actually stopped something (`False` when already stopped or nonexistent, so the reaper
    neither double-logs nor issues empty stops), and **`attach` brings it back with the same
    base URL and no rebuild**.
50. **A new allocation must not steal a stopped container's host port** (§5.4) — pinned with
    two sessions and a two-value port sequence. A failing `docker ps` degrades to "nothing
    reserved" rather than blocking allocation.
51. The fake docker used in tests models **three** container states (running / stopped /
    absent) and the test file says explicitly they must not be collapsed into one boolean —
    `attach` needs the stopped-vs-absent distinction to choose between restoring and
    reporting unrecoverable.

### 9.8 Idle reaper

52. **Tier selection:** idle 2h → stop only; idle 30h → force_release only (never both);
    idle 0.5h → untouched. A mixed batch partitions correctly in one sweep.
53. **`waiting` and `running` are never reclaimed**, however overdue (5h waiting, 30h running
    → untouched).
54. **A session with no task id is never scanned** (it never started a container).
55. **Either tier can be disabled with a `0` threshold** and the other keeps working — with
    remove disabled, even a 999-hour session is only ever stopped, so it stays recoverable.
56. **A provider exception on one session must not block the others**, and a missing provider
    is a safe no-op.

### 9.9 Preview gateway

57. **Roots of one session share one token; only the last release unmounts.**
58. **A container rebuild (changed base URL) rotates the token and immediately 404s the old
    one.**
59. **Lazy mount is idempotent for the same base URL, and release falls back to the
    session key** even for a root that never went through the allocate path.
60. **Panel URL shapes** exactly as in §6.1 — the `?path=…/websockify` query, the
    no-trailing-slash terminal, the trailing-slash code path.
61. **No CORS headers on the preview origin**, and auth headers appear only on the
    gateway→container leg (compared case-insensitively — urllib normalizes header case).
62. **The preview port serves only `/sandbox-preview/<valid-token>/*`** — an unknown token,
    `/`, and `/api/v1/sessions` all 404.
63. **An unreachable upstream yields `HTTP/1.1 502`, not a 101 followed by a close**;
    a reachable one yields `HTTP/1.1 101` with a correctly computed accept value.

### 9.10 Image input

64. **400 vs 422 split:** a bad attachment (type / base64 / size) is **400** and the session
    stays `idle` — *the turn is never seeded*. Empty text with no images is **422**.
65. **[R] A text-only turn must carry no `images` key at all** — the event data must be
    exactly `{"content": …}`, not `{"content": …, "images": []}`. Explicitly a wire-compat
    regression guard for the pre-image vocabulary.
66. **Whitelist rejection happens before any store write**; the oversize case decodes first
    but must also store nothing.
67. **The size cap is inclusive** — exactly 5 MB passes, one byte more fails.
68. **`media_type` is normalized** (trimmed and lowercased) before storage.
69. **`Content-Type` on read-back is sniffed, not echoed.**
70. The whitelist and cap are asserted **identical on both sides** (a backend test and a
    frontend test both name `{png, jpeg, gif, webp}` and `5 * 1024 * 1024`). The frontend
    additionally distinguishes three reject verdicts: `type` / `size` / `missing`.

### 9.11 MCP resolution

71. **Token format `"<space_id>:<alias>"`**, and the resolved spec always carries the **clean
    alias**, never the scoped token.
72. **The per-turn token set is sorted**, covers only *enabled* connectors of that scope, and
    excludes other scopes.
73. **Disabled / unknown / wrong-scope / malformed tokens all resolve to `None`** — a
    malformed token is skipped, never raised.
74. **The same alias in two scopes stays isolated** (different URLs).
75. **With no store attached at all**, the token set is `()` and resolution is `None` —
    graceful degradation, byte-identical to a no-MCP deployment.
76. **End to end:** an enabled connector is actually handshaked at task start (`initialize` +
    `tools/list` reach the server, with the credential header on the wire); a disabled one
    never touches the network.
77. Spec shapes: http → alias/url/headers dict/`tool_subset` **tuple**; stdio → `argv` tuple
    with the command prepended to args, plus an env dict.

### 9.12 Routing and catalog

78. **Dispatch is keyed on `request.model`; unregistered models fall to the default gateway;
    an unconfigured gateway name falls back rather than raising.**
79. **A per-gateway header transform applies only to the route that registered one** — the
    other route's headers pass through untouched.
80. **The router must satisfy `isinstance` for both the streaming and header-aware
    protocols** — the runtime probes capability that way.
81. **With a secondary gateway configured, `build_provider` returns a router but the reported
    provider name stays `"openai"`** (the health endpoint and the `provider_headers` gate
    read it).
82. **No primary credentials → `"mock"`, even when a secondary is fully configured.**
83. **Catalog registration flips compaction from off to on** for a custom model declaring a
    context window, and the derived config's usable window is (context − max_output − buffer)
    with a non-zero tail budget.
84. **A models.json entry must never clobber an SDK-authoritative catalog row** (asserted by
    object identity, with a deliberately bogus window in the config).
85. **Models without a declared context window stay out of the catalog** (compaction off,
    same as any unknown model) — the registration is opt-in, not blanket.
86. The routing test suite explicitly clears the secondary-gateway settings to isolate from a
    developer machine where a real secondary may be configured. Do the same.

### 9.13 Workspace files

87. Listing is **sorted**, recurses, and prunes every hidden entry at every depth (including
    the engine's metadata directory).
88. **A top-level symlink to an external tree is excluded and not traversed.**
89. **A missing workspace directory returns `[]`, not an error.**
90. **Path containment is judged after realpath normalization**, so `..` traversal, absolute
    paths, the empty string, **and an inside→outside symlink** all resolve to "rejected".
    The symlink case is the one a naive check misses.

### 9.14 The two SDK adapters

91. **`run_argv` sends `cd <cwd> && <shlex-quoted argv>`**, the caller's timeout rides as the
    SDK per-call timeout, and **`stderr` is always empty** — the AIO container merges streams
    into stdout. Do not invent a stderr channel.
92. **A missing exit code must stay missing** all the way through the transport, so each
    inherited consumer applies its own default: with no exit code, `is_file()` and `exists()`
    are `False` (stat treats absence as failure) while `run_argv().returncode` is `0`.
    Coercing `None → 0` at the transport layer breaks the first two.
93. **A truncated inline echo plus a spill path must be recovered with `tail -c <cap+1>`**,
    not read from the lossy inline echo.
94. **[Forward-looking pin]** `full_output_file_path` is **not a declared field** of the SDK's
    shell result model — it survives only because the generated models allow extras. The test
    validates the *real* model with that key present, so an SDK bump that stops allowing
    extras fails loudly here instead of silently losing spilled output. Keep an equivalent
    canary.
95. **In-band failures (`200 + success:false`) raise on both the shell and the write path**,
    mapping `data.error_type` to the stdlib exception; without `error_type` it degrades to a
    generic typed error carrying the server message.
96. **A transport read timeout is a *timed-out run* (`returncode -1`, `timed_out True`), an
    `ApiError` is a *failed run* (`returncode -1`, `timed_out False`, server message in
    stderr).** Two different outcomes, same return type.
97. **`create_exclusive` gates with `set -C; : > <path>` first, then writes.** An **indeterminate**
    gate (no exit code) must be treated as "exists", not "opened" — otherwise an existing file
    could be silently overwritten.
98. **Reads over the total cap raise cleanly**; the download stream is reassembled byte-exact
    across chunks.
99. **Auth headers ride as a per-call request option**, not client-level state.
100. **Browser:** click passes the index natively (no selector bridge); `type` is
     fill-then-optional-`press_key("Enter")`; the element line format is
     `[<index>] <<tag>> <text> (<href>)` with the href in parens only when present; `extract`
     joins page markdown and the element list under the literal heading
     `"# Interactive elements"`; screenshot must hit the **page** endpoint, joins the streamed
     chunks, and raises on empty bytes.

### 9.15 Frontend units

101. **Streaming buffer:** a different `call_id` replaces the buffer wholesale (the retry
     invariant); a kind flip at the same index replaces rather than concatenates;
     empty-text blocks render nothing; blocks render sorted by index.
102. **Invalid deltas are ignored by reference identity** (`toBe(state)`) — `null`, `{}`,
     empty `call_id`, unknown `kind`, non-string `text`, non-finite `index`. Forward
     compatibility and malformed-frame safety in one rule.
103. **`resetCall`:** matching id clears; mismatched id returns the *same object reference*
     (a genuine no-op, not a new equal object); `null` clears unconditionally.
104. **[R] Trace-page compaction cards pair per task stream, never by adjacency.** A
     subagent's `Compacted` must not claim the main stream's `CompactionRequested`. The
     card's `kind` comes from the *request's* reason, the replaced count from the
     *Compacted* — split provenance. An orphan `Compacted` becomes its own card with kind
     `unknown`; a request that never lands stays a card with a null compacted-seq.
105. **Image attach:** the wire payload is exactly `{media_type, data_base64}` (local id,
     data URL and filename are stripped); a data-URL parser that is not `data:*;base64,`
     returns `""` rather than throwing; a null DataTransfer yields `[]`.

---

## 10. Traps and scars

Everything below reads, in the source, as "we learned this the hard way".

### 10.1 Threading and lifecycle

1. **The job-queue worker must swallow `InvalidStateError`** on result delivery. See §9.4.26.
   Otherwise one disconnecting client kills the process's ability to drive any turn.
2. **Read paths never go through the serial job queue.** Replay, raw events, content get/put,
   file listing and file read all go through the async thread pool. The queue is a *global*
   single-thread queue; parking reads behind it is a whole-app hang. (See §9.4.27–28.)
3. **Cancel is called directly from the request thread**, not queued. That is the official
   cross-thread design: cancel on one thread, drive on another, the registry locks, the
   engine polls at step boundaries. Verified to take effect *between* tool steps and *not* to
   interrupt an in-flight LLM call.
4. **The pending-session slot has four lock-free invariants**, written out in the code, and
   breaking any one requires re-reviewing with a lock: ① each task's `TaskCreated` is emitted
   exactly once (post-commit, no re-emit) so there is no same-key write race; ② root and child
   write different keys and never overwrite each other; ③ a single dict/set read or write is
   atomic under the GIL, and a stale read at worst routes one beat late; ④ the slot is
   set/cleared only inside the fresh-start path (which the serial worker makes non-reentrant)
   and is consumed **only** by the root branch — a subtask's `TaskCreated` (non-empty parent)
   cannot eat it.
5. **Any other code path that calls `seed_start` must go through the same serial worker.**
   The memory-consolidation pass does, explicitly: its internal `seed_start` emits a root
   `TaskCreated`, and running concurrently with a user session's seed window would let the
   curation task consume the pending-session slot and splice consolidation events into a
   user's conversation. Internal agent runs are intercepted *before* the binding block for
   the same reason.
6. **A terminal state is a per-task absorbing state.** Without this, `cancel()` emits
   `TaskCancelled` on the request thread while the same turn's `TaskSuspended` is emitted by
   a worker at its own pace — no ordering guarantee. A late `TaskSuspended(question-…)` flips
   an already-terminated turn back to `waiting` and **wedges the session permanently**: new
   messages get 409, yet there is no real question to answer. Track it **per task**, not per
   session, so cancelling an old task cannot freeze the session's next task.
7. **The seeded lease must be yielded in a `finally`.** `seed_start` has already persisted
   the lease; if bookkeeping throws before the yield, the lease stalls until the worker
   pool's stale sweep (default 600s) reclaims it — the session sits wedged with nobody
   driving. "Error notice and driving coexist" beats a stalled lease.
8. **Status flips to `waiting` on `UserQuestionRequested`, before the `question` frame is
   pushed** — so a client can answer the instant it sees the question without losing a race
   against the not-yet-emitted `TaskSuspended`.
9. **Restart ordering**: subscribe first, then rebuild the task→session map from the DB, then
   start the worker pool. The pool's stale-lease requeue auto-re-drives tasks that were
   mid-turn at crash time; if the map is not rebuilt first, their events cannot route to a
   session. Accepted loss: in-flight *subtask* mappings are memory-only and do not survive.
10. **The status machine must not go idle on a subtask barrier.** Both the translator and
    the status updater use the same predicate. Flipping to idle would let the user inject
    messages while subagents run and pollute the conversation — the session would look ready
    for input while the subagent executes. The predicate reads the canonical tag, not the
    fields, because `SubtaskGroupCompleted` has no `handle` (which is exactly what
    distinguishes it from a human-response wake).

### 10.2 The wire

11. **Subscribe → first byte → re-fetch → replay → `replay_done` → live.** All four reasons
    are in the startup-order section of [`wire-contract.md`](wire-contract.md) §4.2. Getting
    any of them wrong produces an intermittent, environment-dependent bug.
12. **A synthetic `turn_started` is pushed before the drive job is queued.** `seed_start`
    blocks synchronously on container allocation (docker run + health check, 2–10s), during
    which neither `TaskCreated` nor `user_message` is emitted and the UI looks dead. For a
    *new* session the SSE connection does not exist yet, so the frontend's optimistic send
    covers it instead.
13. **`error` alone must unlock `running` on the client.** An answer-drive failure pushes
    only `error`; and a `turn_finished` can be lost on a live stream. Depending solely on
    `turn_finished` leaves the UI stuck forever.
14. **Client-side dedup of the optimistic user bubble must search the whole list**, not just
    the tail — after a reset the SSE replay can beat the optimistic dispatch.
15. **Cancelled steps and subtask cards must be force-closed client-side.** A cancelled tool
    never receives a paired result, and the cancel-cascade `subtask_finished` frames are
    synthetic (not replayed), so after a refresh only the parent's `turn_finished{cancelled}`
    can close those cards.
16. **`llm_retry` exists only to reset the delta buffer** for the same `call_id`. The retry
    re-streams under the same id; not clearing splices two half-streams into garbage.

### 10.3 Engine interaction

17. **Continuing after a provider fault uses `interrupt` / `turn_failed`, not a new task.**
    A `turn_failed` suspend parks the turn instead of sealing the ledger, and the next
    ordinary message resumes the *same* task with full context — the seq space is unbroken.
    Do not reintroduce the old degradation path that caught `NotResumableError` by class name
    and started a fresh task on the same workspace: it kept the files but **restarted the
    event seq at 0**, so old messages survived only in frontend memory and vanished on
    refresh.
18. **`ContentRef` deref is required wherever a payload field may exceed the inline
    threshold**: subtask outputs, message bodies, thinking blocks, question bodies, tool
    arguments and tool outputs. A missing deref does not error — it renders a repr string.
19. **A translation failure must never propagate into the engine's emit path.** Catch, log,
    drop the frame.

### 10.4 Sandbox

20. See §5.4 — the **stopped-container port reservation** trap, in full.
21. **On a failed restart, `docker stop` the container back; never `docker rm` it.** `attach`
    holds no `SandboxSpec`, so a removed container cannot be rebuilt — a possibly transient
    failure becomes a permanent loss. Leaving it running-but-unreachable is worse still: the
    next attach would treat it as alive and every exec would return a weird connection error.
    Stopping it back preserves a clean, retryable state.
22. **On a failed allocate, DO `docker rm -f`** — that call created the container, keeping it
    is litter. The two cases are opposite and both are correct.
23. **Idle level 1 must stop, not remove** (§5.3), and the **remove level must be checked
    first** in the sweep.
24. **Name the container after the app-level owner, not the root task**, or a session's
    second root task silently starts a second container with a duplicate workspace mount.
25. **Refcount `release`** or terminating one root task tears down a container other roots are
    using. After a restart the counts are gone — fall back to removing by resolved id, and
    keep a `force_release`-by-owner backstop on the deletion path.
26. **Allocation happens *inside* `seed_start`, before the task→session binding exists**, so
    the container-id resolver must fall back to the pending-session slot.
27. **`chmod 0o777` the workspace directory** (and any directory the agent writes into): the
    AIO container runs as non-root uid 1000, and the bind-mounted host directory must be
    writable by it.
28. **Pass the sandbox API key by env-var name, not value.**
29. **A store failure while composing mounts must degrade to "no mounts", never block
    container start.** Same rule for MCP alias resolution: degrade to no MCP, never sink the
    turn.
30. **`trust_env=False` on every loopback HTTP client** — an ambient proxy env var will hang
    calls to `127.0.0.1`.
31. **Check the in-band `success: false` reply** on the sandbox file API — a silent drop lets
    `edit`/`apply_patch` report success with the file unchanged.
32. **Pass `exit_code` through only when the server reported one.**

### 10.5 Preview

33. **Dial upstream before sending the 101** (§6.4). This is the difference between a
    diagnosable 502 and a mystery blank panel.
34. **The three panel paths' trailing-slash and query quirks are load-bearing** (§6.1).
35. **Bound the WS frame length before allocating** (64 MiB).
36. **`SO_SNDTIMEO` on the send side only** — the read side must stay fully blocking or an
    idle VNC panel disconnects itself.
37. **The preview must live on its own origin/port** (§6.2), and a bind failure must not
    block the agent.
38. **Lazy re-mount on a registry miss** — after a restart, requeued tasks take the `attach`
    path and fire no allocate listener, yet the container is still running.

### 10.6 Provider and misc

39. **Register custom-gateway models into the catalog or compaction stays off** and long
    sessions die by truncated tool calls. Silent until it isn't.
40. **Disable reasoning on the title call** or every title is empty.
41. **`base_url` must be the full `/responses` endpoint**, not the gateway root.
42. **`OTEL_EXPORTER_OTLP_ENDPOINT` is deliberately NOT honoured as an enable switch.** A
    k8s operator or shared shell injecting it for other apps must not silently start this
    process exporting traces. Export is opt-in through the app's own key only.
    `OTEL_EXPORTER_OTLP_HEADERS`, by contrast, *is* honoured as a fallback for headers —
    because headers never enable anything by themselves.
43. **`/content/{hash}` sniffs the media type from magic bytes** (PNG / JPEG / GIF / WebP /
    PDF, else octet-stream) because the engine's ContentStore has **no metadata read
    interface**. The hash is the capability: you can only ask for bytes you have already seen
    a ref to.
44. **Session deletion is deliberately lightweight**: delete the DB row first (the user
    perceives instant deletion), then clear in-memory maps, then release the container and
    remove the workspace on a thread pool. It does **not** delete engine data — the EventLog,
    ContentStore and dispatcher state are preserved so the trace page can still inspect the
    execution by task id.
45. **Image input is validated before the turn is seeded.** MIME whitelist
    (`image/png|jpeg|gif|webp`), `b64decode(validate=True)`, 5 MB per image → violations are
    **400** and the turn is never started. Decoding + the DB write run off the event loop.
    The ledger stores only `ImageBlock(ContentRef)`; **base64 never enters the ledger** and
    image bytes never travel the event stream.
46. **Locate the built SPA package-relative first**, repo-relative second.
47. **`AGENT.md` in the workspace is a workaround, not a design goal.** Agent definitions are
    registered statically at Client init, so per-project persona has no runtime seam; a
    workspace file follows the same "wayfinding" convention as an index file and can be
    replaced by per-project `AgentDefinition`s once the SDK grows the seam. Write it
    idempotently (clearing the config deletes the file), and never let a write failure block
    workspace assembly.
48. **You depend on an undeclared field of a generated SDK model.** The sandbox shell result
    carries `full_output_file_path`, which is **not** in the model's declared schema and
    survives only because the generated pydantic models allow extras. Keep a test that
    validates the *real* model with that key present, so an SDK bump that tightens the model
    fails loudly instead of silently dropping spilled command output.
49. **The AIO container merges stderr into stdout.** There is no separate error stream — every
    exec returns one merged blob and `stderr` is always empty. Do not build UI or tooling that
    expects to split them.
50. **The trace page must pair compaction events per task stream, not by adjacency.** A
    subagent's `Compacted` sitting next to the main stream's `CompactionRequested` gets
    mispaired by any naive adjacency scan. And the two halves of the card come from different
    envelopes: the *reason* from the request, the *replaced count* from the landing.
51. **Anything that reads the developer's `.env` at import time contaminates the test
    suite.** The harness has to explicitly force the sandbox off and clear the
    secondary-gateway keys for exactly this reason. Prefer a settings object that is
    constructed and injected over one that reads a file on first touch.
