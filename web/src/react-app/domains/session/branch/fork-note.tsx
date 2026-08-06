/**
 * The banner a fork's own session carries.
 *
 * A fork looks like an ordinary top-level session once you are inside it, so
 * this states the one thing that is not ordinary: it shares the workspace with
 * the session it was forked from. Without it, a user edits a file here, sees
 * the change in the source session, and reads it as corruption — the same
 * surprise the fork affordance warns about, now at the place it lands.
 */

import { SharedWorkspaceNote } from './shared-workspace-note'

export function ForkNote({ branchedAtSeq }: { branchedAtSeq: number | null }) {
  return (
    <div className="shrink-0 border-b border-border bg-surface px-4 py-2">
      <div className="mx-auto flex w-full max-w-[46rem] flex-col gap-0.5">
        <p className="text-[11px] tracking-wide text-ink-3 uppercase">Fork</p>
        <p className="text-xs text-ink-3">
          {branchedAtSeq != null
            ? `Forked from another session at message ${branchedAtSeq}. Everything before it is shared history.`
            : 'Forked from another session. Everything before the fork point is shared history.'}
        </p>
        <SharedWorkspaceNote />
      </div>
    </div>
  )
}
