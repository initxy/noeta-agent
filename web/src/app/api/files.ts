/**
 * The workspace file surface.
 *
 * Reads go through the host-side directory rather than through the container,
 * so a listing works when the session's container is stopped — and so a
 * `local` project, which has no container at all, still has files.
 *
 * Path containment is the backend's job and is not duplicated here: every path
 * parameter is resolved against the project root with both sides realpath'd,
 * which is what catches a symlink inside the workspace pointing outside it.
 * A rejected path is a 400, and the client's job is to show it.
 */

import { API_BASE, apiRequest, queryString, readList } from './client'
import type {
  ArtifactResolvePayload,
  ArtifactResolveRequest,
  FileTextPayload,
  PreviewPayload,
  WorkspaceFile,
  WriteFileRequest,
} from '../types/wire'

const sessionPath = (sessionId: string) => `/sessions/${encodeURIComponent(sessionId)}`

export async function listFiles(
  sessionId: string,
  signal?: AbortSignal,
): Promise<WorkspaceFile[]> {
  const payload = await apiRequest<unknown>(`${sessionPath(sessionId)}/files`, { signal })
  return readList<WorkspaceFile>(payload, 'files')
}

/** Read a file as text. Clipped server-side; `truncated` says whether it was. */
export function readFileText(
  sessionId: string,
  path: string,
  signal?: AbortSignal,
): Promise<FileTextPayload> {
  const query = queryString({ path, mode: 'text' })
  return apiRequest<FileTextPayload>(`${sessionPath(sessionId)}/files/content${query}`, {
    signal,
  })
}

/**
 * The URL for a file's exact bytes.
 *
 * A URL rather than a fetch, for the same reason as `contentUrl`: an image or
 * a PDF preview wants a `src`, not an array buffer the client then has to turn
 * back into an object URL and remember to revoke.
 */
export function fileRawUrl(sessionId: string, path: string): string {
  return `${API_BASE}${sessionPath(sessionId)}/files/content${queryString({ path, mode: 'raw' })}`
}

// ---------------------------------------------------------------------------
// Phase 5 — declared, not implemented
// ---------------------------------------------------------------------------
//
// The three surfaces below belong to the panels phase. Their request and
// response types live in `types/wire.ts` so that phase inherits a settled
// vocabulary instead of inventing one, but implementing the calls now would
// ship three functions with no caller and no test.
//
//   PUT   /sessions/{id}/files/content    WriteFileRequest -> FileTextPayload
//                                         409 on a base_mtime mismatch
//   POST  /sessions/{id}/artifacts/resolve ArtifactResolveRequest
//                                         -> ArtifactResolvePayload
//   GET   /sessions/{id}/preview          -> PreviewPayload
//                                         404 when the session has no container
export type {
  ArtifactResolvePayload,
  ArtifactResolveRequest,
  PreviewPayload,
  WriteFileRequest,
}
