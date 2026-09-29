/**
 * The one sentence every fork surface has to carry.
 *
 * `fork` branches the conversation and **not** the workspace: the child session
 * keeps the source's `workspace_dir` and acts on the same files. Restoring files
 * is `rewind` (the separate "undo last turn") — under one directory per project
 * it reverts what a sibling session wrote, which is why undo carries its own
 * explicit warning (`REWIND_WORKSPACE_WARNING`).
 *
 * Left unsaid, a user reads "fork" as "sandbox", edits a file in one session,
 * sees the change in the other, and files it as data corruption. Saying it is
 * cheaper than answering it — so the note appears wherever a fork is offered
 * (`EditAndRetry`) and on the child session itself.
 */

import { cn } from '@/react-app/design-system'

export const SHARED_WORKSPACE_NOTE =
  'A fork branches the conversation, not the files — it shares the project directory with its source, and edits on one are visible on the other.'

export function SharedWorkspaceNote({ className }: { className?: string }) {
  return <p className={cn('text-xs text-ink-3', className)}>{SHARED_WORKSPACE_NOTE}</p>
}

/**
 * The warning `rewind` must carry — the mirror risk of the fork note.
 *
 * Undo restores files, and the same shared directory that makes fork safe
 * makes this dangerous: rewinding one session reverts files another session
 * wrote after this point. That is the D2/D6 trade-off the product now exposes,
 * so the surface offering undo says it out loud before the click.
 */
export const REWIND_WORKSPACE_WARNING =
  'Undo restores the project files to their state before this turn. This directory is shared with your other sessions — any changes they made after this point are rolled back too.'
