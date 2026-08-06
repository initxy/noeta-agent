/**
 * The three calls the panel surface adds to the file API.
 *
 * Kept out of `api/files.ts` so the panel phase owns its own module rather
 * than editing a file three other slices import; `files.ts` declares these
 * endpoints in a comment and this is the implementation of that declaration.
 *
 * The conflict path is the reason this module has more than three functions in
 * it. `PUT /files/content` is optimistic-locked on `base_mtime` and answers
 * 409 when the bytes moved underneath the editor. Under D2 every session of a
 * project shares one directory, so "the file changed while you were editing it"
 * is not an edge case — it is the agent doing its job in another tab. A save
 * that silently fails there is the worst outcome available, so the 409 is
 * given a name here and a rendering upstream.
 */

import { ApiError, apiRequest, isApiError } from './client'
import type {
  ArtifactResolvePayload,
  FileTextPayload,
  PreviewPayload,
  ResolvedArtifact,
  WriteFileRequest,
} from '../types/wire'

const sessionPath = (sessionId: string) => `/sessions/${encodeURIComponent(sessionId)}`

/**
 * Confirm a batch of client-derived candidates against the file surface.
 *
 * The response overwrites `exists / size / updatedAt / preview`; see
 * `app/artifacts/resolve.ts` for the fold. The batch is capped by the caller
 * (`resolvablePaths`), and an empty list short-circuits — a session with no
 * artifacts must not spend a request per keystroke of the turn that has not
 * produced one yet.
 */
export async function resolveArtifacts(
  sessionId: string,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<ResolvedArtifact[]> {
  if (paths.length === 0) return []
  const payload = await apiRequest<ArtifactResolvePayload>(
    `${sessionPath(sessionId)}/artifacts/resolve`,
    { method: 'POST', json: { paths: [...paths] }, signal },
  )
  return payload?.artifacts ?? []
}

/**
 * Write a text file back, optimistically locked on the mtime it was read at.
 *
 * `base_mtime` must come from the read that produced the bytes in the editor —
 * never from the artifact's resolve-time metadata, which is a stat from an
 * unrelated moment and would let a stale editor overwrite a newer file while
 * believing it had checked.
 */
export function writeFileText(
  sessionId: string,
  body: WriteFileRequest,
  signal?: AbortSignal,
): Promise<FileTextPayload> {
  return apiRequest<FileTextPayload>(`${sessionPath(sessionId)}/files/content`, {
    method: 'PUT',
    json: body,
    signal,
  })
}

/** The optimistic lock failed: someone else wrote the file first. */
export function isWriteConflict(error: unknown): error is ApiError {
  return isApiError(error) && error.status === 409
}

/**
 * The mtime the server says the file currently has, when the 409 carried one.
 *
 * Optional by design: the conflict is fully expressed by its status, and the
 * recovery ("reload theirs" or "re-read then overwrite") works without this
 * field. It is read when present because it saves the overwrite path a round
 * trip, and its absence must never turn a handled conflict into an unhandled
 * one.
 */
export function conflictMtime(error: unknown): number | null {
  if (!isApiError(error)) return null
  const body = error.body
  if (typeof body !== 'object' || body === null) return null
  const record = body as Record<string, unknown>
  const nested = record.error
  const source =
    typeof nested === 'object' && nested !== null ? (nested as Record<string, unknown>) : record
  const value = source.current_mtime ?? source.mtime
  return typeof value === 'number' ? value : null
}

/**
 * The sandbox preview channel for a session, or `null` when it has none.
 *
 * A 404 is the documented answer for a session with no container — every
 * `local` project, and any sandbox session whose container has not started —
 * and it is a fact about the session, not a failure. Mapping it to `null` here
 * keeps every caller from having to know that; anything else still throws.
 */
export async function fetchPreviewChannel(
  sessionId: string,
  signal?: AbortSignal,
): Promise<PreviewPayload | null> {
  try {
    return await apiRequest<PreviewPayload>(`${sessionPath(sessionId)}/preview`, { signal })
  } catch (error) {
    if (isApiError(error) && error.status === 404) return null
    throw error
  }
}
