/**
 * The trace surface: raw engine envelopes, for debugging only.
 *
 * The UI event stream is a translation; this is the untranslated record behind
 * it. It exists as a separate page because the two must never be confused —
 * anything the product renders comes from the vocabulary, and anything only
 * visible here is by definition not part of the contract.
 */

import { apiRequest, queryString } from './client'
import type { RawEventsPayload, TraceCursor } from '../types/wire'

/**
 * Fetch the next increment of raw envelopes.
 *
 * The cursor is a `{task_id: last_seq}` **map**, not a scalar, because every
 * task stream counts `seq` independently. It is sent as JSON in the query
 * string; passing back the cursor from the previous response yields a strict
 * increment across every stream at once, including subtasks discovered in this
 * round's root increment.
 *
 * An empty or omitted cursor asks for the stream from the beginning.
 */
export function fetchRawEvents(
  sessionId: string,
  cursor?: TraceCursor | null,
  signal?: AbortSignal,
): Promise<RawEventsPayload> {
  const hasCursor = cursor != null && Object.keys(cursor).length > 0
  const query = queryString({ cursor: hasCursor ? JSON.stringify(cursor) : undefined })
  return apiRequest<RawEventsPayload>(
    `/trace/sessions/${encodeURIComponent(sessionId)}/raw-events${query}`,
    { signal },
  )
}
