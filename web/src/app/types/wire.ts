/**
 * Wire types for the `/api/v1` REST surface.
 *
 * These describe bytes on the wire, nothing else — no React, no rendering
 * concerns, no derived view models. Field names are the server's, so they stay
 * `snake_case` here and are translated exactly once, at the fold, into the
 * camelCase view models the UI renders.
 *
 * Everything is single-user and local: no auth, no cookies, no CSRF, no
 * pagination.
 */

/**
 * Where a project's turns execute. Welded into the task at seed time, so
 * changing it only affects sessions created afterwards.
 */
export type ExecutionTier = 'local' | 'sandbox'

/** The session status vocabulary the whole product depends on. */
export type SessionStatus = 'idle' | 'running' | 'waiting'

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

/** `GET /health` — the liveness + identity probe. */
export interface HealthPayload {
  /** `"ok"` when the backend is serving. */
  status: string
  /** Backend distribution version. */
  version: string
  /** The *resolved* LLM provider — `"mock"` on a credential-free machine. */
  provider: string
  /** Whether the sandbox tier can actually run here (Docker reachable). */
  sandbox_available: boolean
  /** Absolute path of the data directory this backend is writing to. */
  data_dir: string
}

/**
 * One selectable model.
 *
 * `efforts` is a plain string list rather than a closed union on purpose: the
 * ladder comes from `models.json`, which the user edits, and a model that
 * offers an effort this build has never heard of must still be selectable.
 */
export interface Model {
  id: string
  label: string
  default: boolean
  efforts: string[]
  default_effort: string | null
}

export interface ModelsPayload {
  models: Model[]
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

/** A project: one directory on disk plus the agent config brought to it. */
export interface Project {
  id: string
  name: string
  /** Absolute path. All sessions of the project share it as their workspace. */
  directory: string
  tier: ExecutionTier
  default_model: string | null
  default_effort: string | null
  persona: string | null
  memory_enabled: boolean
  created_at?: string
  updated_at?: string
}

export interface ProjectsPayload {
  projects: Project[]
}

export interface CreateProjectRequest {
  name: string
  /** Must be absolute — a relative path is rejected with 422. */
  directory: string
  tier: ExecutionTier
  /** Create the directory when it does not exist yet. */
  create_directory?: boolean
}

export interface UpdateProjectRequest {
  name?: string
  tier?: ExecutionTier
  default_model?: string
  default_effort?: string
  persona?: string
  memory_enabled?: boolean
}

/** The focused view of the agent configuration a project brings to its sessions. */
export interface AgentConfig {
  persona: string | null
  default_model: string | null
  default_effort: string | null
  memory_enabled: boolean
}

/**
 * How an MCP server is reached. `http` uses `url` + `headers`; `stdio` runs
 * `argv` locally with `env`.
 */
export type ConnectorTransport = 'http' | 'stdio'

/**
 * An MCP connector, as it is **read back**.
 *
 * Credential values never leave the backend: every read path scrubs them to
 * sorted name lists, which is why this type can carry a connector's shape
 * without ever carrying a secret.
 *
 * The command is `argv` — one already-split array, not a `command` string plus
 * an `args` list. That is the store's column and `McpServerSpec`'s field, and
 * splitting a command line is the client's job precisely once, in the form.
 */
export interface Connector {
  project_id: string
  alias: string
  transport: ConnectorTransport
  /** HTTP transport; `""` for stdio. */
  url: string
  /** Stdio transport; `[]` for HTTP. */
  argv: string[]
  /** Sorted header names; the values are never returned. */
  header_names: string[]
  /** Sorted environment variable names; the values are never returned. */
  env_names: string[]
  /** When non-empty, only these tools are exposed to the model. */
  tool_subset: string[]
  enabled: boolean
  created_at: string
  updated_at: string
}

export interface ConnectorsPayload {
  connectors: Connector[]
}

/**
 * Writing a connector, where credential values *are* allowed — this is the
 * only direction they travel.
 */
export interface ConnectorInput {
  alias: string
  transport: ConnectorTransport
  enabled?: boolean
  url?: string
  argv?: string[]
  tool_subset?: string[]
  headers?: Record<string, string>
  env?: Record<string, string>
}

export type ConnectorPatch = Omit<Partial<ConnectorInput>, 'alias'>

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * One task stream inside a session. A session starts with zero of these; the
 * first message seeds the first one, and each `fork` appends a sibling.
 */
export interface TaskStream {
  task_id: string
  /** How the stream came to exist — `"root"` for the first, `"branch"` for a fork. */
  kind: string
  created_at: string
  /**
   * Lineage, set on a `branch` and null on a `root`.
   *
   * These two are the **only durable** record of a fork: `branch_created` is
   * synthetic and never replays, so after a refresh this is the one place a
   * branch's parent still exists.
   */
  source_task_id?: string | null
  branched_at_seq?: number | null
}

/** A session as the sidebar lists it. */
export interface SessionRow {
  id: string
  project_id: string
  title: string
  status: SessionStatus
  created_at: string
  updated_at: string
  pinned?: boolean
  archived?: boolean
  /**
   * A strictly monotonic counter bumped by **every** writer, including the
   * engine threads that record status.
   *
   * The sidebar's unread rule keys on it rather than on `updated_at`: a turn
   * that starts and finishes inside one poll interval reads idle → idle, and a
   * millisecond timestamp cannot tell two writes apart.
   */
  version?: number
  /**
   * Lineage of a fork, null on an ordinary session. A fork is its own child
   * session: `parent_session_id` is the sidebar-nesting link (nulled if the
   * parent is deleted, which de-nests rather than removes the child), and
   * `branched_at_seq` is the user-message seq it was forked at — the "forked
   * at message N" copy. The parent's source stream stays server-side; the
   * client never needs the task id, only the parentage.
   */
  parent_session_id?: string | null
  branched_at_seq?: number | null
}

/** A session opened: the row plus the task streams it owns. */
export interface SessionDetail extends SessionRow {
  task_streams: TaskStream[]
}

export interface SessionsPayload {
  sessions: SessionRow[]
}

export interface CreateSessionRequest {
  title?: string
}

export interface UpdateSessionRequest {
  title?: string
  pinned?: boolean
  archived?: boolean
}

/**
 * An image on its way to the model.
 *
 * Exactly two fields reach the wire. The composer's local id, the data URL it
 * previewed from and the original filename are all stripped — they are client
 * bookkeeping, and sending them meant the same bytes travelled twice.
 */
export interface ImageAttachment {
  media_type: string
  data_base64: string
}

export interface SendMessageRequest {
  text: string
  images?: ImageAttachment[]
  model?: string
  effort?: string
  skills?: string[]
  /** Which stream to append to; omitted means the session's current one. */
  task_id?: string
}

/** The 202 body of every verb that queues work: which stream it landed on. */
export interface AcceptedTask {
  task_id: string
}

/**
 * One question's answer.
 *
 * A **structured object**, not a bare string, and that is the engine's shape
 * rather than a preference (0.6.x reference contract): `selected` lists the
 * option **labels** the reader picked (at most one unless the question sets
 * `multiSelect`), and `other` is the always-available free-text slot — the
 * auto-appended "Other" option. At least one of the two must be present; both
 * may be, and a chosen option with a note beside it is a legal answer.
 */
export interface AnswerValue {
  /** The labels chosen from that question's `options`. */
  selected?: string[]
  /** Free-text for the auto-appended "Other" option. */
  other?: string | null
}

export interface AnswerRequest {
  question_id: string
  /** One answer per question id in the `question` frame — all of them. */
  answers: Record<string, AnswerValue>
}

export interface InterruptRequest {
  task_id?: string
}

export interface ForkRequest {
  task_id: string
  /** The user message to branch at. */
  message_seq: number
}

/**
 * The 201 body of `fork`: the child session it created and that session's own
 * root stream. A fork is a new session nested under its source, so the client
 * navigates to `session_id` and sends the edited message on `task_id`.
 */
export interface ForkedSession {
  session_id: string
  task_id: string
}

export interface RewindRequest {
  /** Required (unlike fork's optional variants): a destructive in-place undo
   *  must name the stream, never fall back to "the newest one". */
  task_id: string
  /** The user message to re-base to. This and everything after it are undone. */
  message_seq: number
}

/** The 200 body of `rewind`: the (unchanged) stream that re-based in place. */
export interface RewoundStream {
  task_id: string
}

// ---------------------------------------------------------------------------
// Workspace files
// ---------------------------------------------------------------------------

/**
 * One file in the project directory. Read from the host side, so the listing
 * works even when the session's container is stopped.
 */
export interface WorkspaceFile {
  path: string
  size: number
  /** Seconds since the epoch, as the host reports it. */
  mtime: number
}

export interface FilesPayload {
  files: WorkspaceFile[]
}

export interface FileTextPayload {
  path: string
  content: string
  /** True when the file exceeded the read cap and `content` is a prefix. */
  truncated: boolean
  mtime: number
}

/** Phase 5. `base_mtime` is the optimistic lock; a mismatch is a 409. */
export interface WriteFileRequest {
  path: string
  content: string
  base_mtime: number
}

/** Phase 5. The capped batch the artifact panel resolves through. */
export interface ArtifactResolveRequest {
  paths: string[]
}

/**
 * Phase 5. The server's verdict on a client-derived artifact candidate.
 *
 * `updatedAt` is camelCase because the contract names these four fields as the
 * *client-side* fields the response overwrites, not as a fresh server resource.
 */
export interface ResolvedArtifact {
  path: string
  exists: boolean
  size: number | null
  updatedAt: string | null
  preview: string | null
}

export interface ArtifactResolvePayload {
  artifacts: ResolvedArtifact[]
}

/** The three surfaces the sandbox preview channel proxies from the container. */
export type PreviewPanel = 'browser' | 'terminal' | 'code'

/**
 * Phase 5. 404 when the session has no container, and the panel hides itself.
 *
 * `port` is `null` when the preview origin could not bind: a busy port must
 * cost the panels and never the conversation. `panels` maps each surface to an
 * **absolute path on that origin**, quirks included — the client joins, it does
 * not reconstruct.
 */
export interface PreviewPayload {
  token: string
  port: number | null
  panels: Partial<Record<PreviewPanel, string>>
}

// ---------------------------------------------------------------------------
// Trace
// ---------------------------------------------------------------------------

/**
 * The raw-events cursor: `{task_id: last_seq}`.
 *
 * A map rather than a scalar because every task stream counts `seq`
 * independently — a single cursor read only the root stream, and clicking a
 * subagent on the trace page then showed nothing.
 */
export type TraceCursor = Record<string, number>

/**
 * One engine envelope, serialized. Diagnostics only: the shape is the engine's
 * and this product deliberately does not model it.
 */
export interface RawEnvelope {
  task_id: string
  seq: number
  type: string
  [field: string]: unknown
}

export interface RawEventsPayload {
  events: RawEnvelope[]
  cursor: TraceCursor
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** One entry of FastAPI's `RequestValidationError` body. */
export interface ValidationErrorEntry {
  /** Path to the offending field, e.g. `["body", "directory"]`. */
  loc?: unknown[]
  msg?: string
  type?: string
}

/**
 * The error envelope the backend returns on a non-2xx.
 *
 * Every field is optional because this type describes what we are willing to
 * *read*, not what the server promises: an error body is exactly the payload
 * least likely to match its schema, so the parser in `app/api/client.ts`
 * degrades through these shapes rather than trusting any one of them.
 *
 * The product's own envelope is `{error: {code, message}}`; the rest of the
 * union is what FastAPI emits before our handlers ever see the request.
 */
export interface ApiErrorBody {
  detail?: string | { code?: string; message?: string } | ValidationErrorEntry[]
  error?: { code?: string; message?: string }
  code?: string
  message?: string
}
