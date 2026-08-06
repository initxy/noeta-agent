/**
 * Reading the server's per-row version off a session row.
 *
 * `version` is the one field the sidebar's whole reconciliation rests on:
 * monotonic, bumped inside the same UPDATE as the change it describes, and
 * bumped by **every** writer including the engine threads recording a status
 * change. That last part is what makes it usable as an activity mark as well as
 * a conflict token — one counter, so any two states of a row are comparable.
 *
 * It is optional on the wire, so this defaults to 0: a row without a version
 * simply never wins a comparison, which degrades the protocol to "the server
 * always loses" rather than to something wrong.
 */

import type { SessionRow } from '@/app/types'

/**
 * Kept as a name rather than collapsed into `SessionRow` at every call site:
 * the sidebar's modules read as "a row whose version I depend on", which is a
 * fact about this code and not about the wire.
 */
export type VersionedSessionRow = SessionRow

/** The row's version, or 0 when the wire did not carry one. */
export function versionOf(row: VersionedSessionRow): number {
  return typeof row.version === 'number' ? row.version : 0
}
