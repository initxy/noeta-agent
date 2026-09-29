/**
 * Sessions and the verbs that drive them.
 *
 * A session is the application-layer unit of conversation — what the sidebar
 * lists, resumes and deletes — and it owns exactly one stream once messaged
 * (its root). `fork` no longer appends a sibling stream: it mints a new child
 * session (nested under its source in the sidebar) whose root is the forked
 * task.
 *
 * The three stop-shaped verbs are not interchangeable:
 *
 * - `interrupt` halts the in-flight turn and leaves the conversation alive;
 * - `cancel` kills the conversation and is terminal;
 * - `fork` writes nothing to the source stream — it returns the new child
 *   session and that session's root task.
 */

import { API_BASE, apiRequest, queryString, readList } from './client'
import type {
  AcceptedTask,
  AnswerRequest,
  CreateSessionRequest,
  ForkRequest,
  ForkedSession,
  InterruptRequest,
  RewindRequest,
  RewoundStream,
  SendMessageRequest,
  SessionDetail,
  SessionRow,
  UpdateSessionRequest,
} from '../types/wire'

const sessionPath = (sessionId: string) => `/sessions/${encodeURIComponent(sessionId)}`

export async function listSessions(
  projectId: string,
  signal?: AbortSignal,
): Promise<SessionRow[]> {
  const payload = await apiRequest<unknown>(
    `/projects/${encodeURIComponent(projectId)}/sessions`,
    { signal },
  )
  return readList<SessionRow>(payload, 'sessions')
}

export function createSession(
  projectId: string,
  body: CreateSessionRequest = {},
  signal?: AbortSignal,
): Promise<SessionDetail> {
  return apiRequest<SessionDetail>(`/projects/${encodeURIComponent(projectId)}/sessions`, {
    method: 'POST',
    json: body,
    signal,
  })
}

export function getSession(sessionId: string, signal?: AbortSignal): Promise<SessionDetail> {
  return apiRequest<SessionDetail>(sessionPath(sessionId), { signal })
}

export function updateSession(
  sessionId: string,
  body: UpdateSessionRequest,
  signal?: AbortSignal,
): Promise<SessionDetail> {
  return apiRequest<SessionDetail>(sessionPath(sessionId), {
    method: 'PATCH',
    json: body,
    signal,
  })
}

export function deleteSession(sessionId: string, signal?: AbortSignal): Promise<void> {
  return apiRequest<void>(sessionPath(sessionId), { method: 'DELETE', signal })
}

/**
 * Send a turn. 202 with the stream it landed on; 409 while a turn is running
 * or a question is pending, and 422 for a model or effort the backend rejects
 * — which it does before the request can reach a provider.
 */
export function sendMessage(
  sessionId: string,
  body: SendMessageRequest,
  signal?: AbortSignal,
): Promise<AcceptedTask> {
  return apiRequest<AcceptedTask>(`${sessionPath(sessionId)}/messages`, {
    method: 'POST',
    json: body,
    signal,
  })
}

export function answerQuestion(
  sessionId: string,
  body: AnswerRequest,
  signal?: AbortSignal,
): Promise<void> {
  return apiRequest<void>(`${sessionPath(sessionId)}/answer`, {
    method: 'POST',
    json: body,
    signal,
  })
}

/** Halt the in-flight turn. The conversation survives and accepts the next message. */
export function interruptSession(
  sessionId: string,
  body: InterruptRequest = {},
  signal?: AbortSignal,
): Promise<void> {
  return apiRequest<void>(`${sessionPath(sessionId)}/interrupt`, {
    method: 'POST',
    json: body,
    signal,
  })
}

/** Kill the conversation. Terminal — use `interruptSession` to merely stop a turn. */
export function cancelSession(sessionId: string, signal?: AbortSignal): Promise<void> {
  return apiRequest<void>(`${sessionPath(sessionId)}/cancel`, { method: 'POST', signal })
}

/**
 * The `code` a 409 from `fork` carries. Stable; the message is not.
 *
 * The engine refuses three shapes: an unknown stream, a subtask, and a
 * `message_seq` that is not a user message — plus the one a UI hits by
 * accident, **the opening message**, which has no prior turn to branch from.
 */
export const NOT_FORKABLE = 'not_forkable'

/**
 * Fork at a user message. 409 when the stream is not forkable.
 *
 * Returns the new **child session** and its root stream: a fork is its own
 * session nested under the source, so the caller navigates to `session_id` and
 * sends the edited message on `task_id`. Both sessions share the project
 * directory — a fork does not restore workspace files (that is `rewind`, the
 * separate "undo last turn") — which the UI states at the fork moment and on
 * the child.
 */
export function forkSession(
  sessionId: string,
  body: ForkRequest,
  signal?: AbortSignal,
): Promise<ForkedSession> {
  return apiRequest<ForkedSession>(`${sessionPath(sessionId)}/fork`, {
    method: 'POST',
    json: body,
    signal,
  })
}

/**
 * The `code` a 409 from `rewind` carries when the anchor is not a user message
 * on the stream. Stable; the message is not. (The other 409, `session_busy`,
 * is the shared code every turn-conflict verb uses.)
 */
export const NOT_REWINDABLE = 'not_rewindable'

/**
 * Undo the last turn(s): re-base **this** session's stream to before a user
 * message, restoring workspace files. Not a fork — no child session and no
 * navigation; the same stream re-bases in place and the visible truncation
 * arrives as a `rewind` SSE frame. Returns the (unchanged) stream id.
 *
 * 409 `session_busy` while a turn is running/waiting; 409 `not_rewindable` for
 * a bad anchor. Because every session of a project shares one directory, the
 * file restore reverts files another session wrote after this point — which
 * the UI states before it calls this.
 */
export function rewindSession(
  sessionId: string,
  body: RewindRequest,
  signal?: AbortSignal,
): Promise<RewoundStream> {
  return apiRequest<RewoundStream>(`${sessionPath(sessionId)}/rewind`, {
    method: 'POST',
    json: body,
    signal,
  })
}

/**
 * The SSE URL for one session's stream.
 *
 * `sinceSeq` is the resume cursor and is **omitted below zero**. The backend
 * reads a missing cursor as "-1", which is the only spelling that replays the
 * very first envelope — sending `since_seq=0` asks it to skip everything at or
 * below seq 0, which is the first frame of the session.
 *
 * There is no per-stream filter: a session has one live stream, and a fork's
 * inherited history is spliced server-side onto that stream's replay.
 */
export function sessionEventsUrl(
  sessionId: string,
  sinceSeq?: number | null,
): string {
  const query = queryString({
    since_seq: sinceSeq !== undefined && sinceSeq !== null && sinceSeq >= 0 ? sinceSeq : undefined,
  })
  return `${API_BASE}${sessionPath(sessionId)}/events${query}`
}
