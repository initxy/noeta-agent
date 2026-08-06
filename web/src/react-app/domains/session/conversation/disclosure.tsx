/**
 * The one collapsible in the transcript.
 *
 * Tool rows, reasoning, aggregate runs and the turn fold are all collapsed by
 * default: a turn is read for its answer, and the work behind it is available
 * rather than imposed.
 *
 * **Collapsed content stays in the DOM, hidden with `until-found`.** That is
 * not a detail of this component, it is the contract the whole find story rests
 * on: the browser's own Ctrl-F skips `display: none` subtrees entirely, so a
 * transcript that unmounts what it collapses is a transcript whose search finds
 * a fraction of itself and silently reports "no results". `UntilFound` owns the
 * mechanism — the attribute has to be written imperatively, because React
 * collapses every truthy value of a boolean DOM prop to `hidden=""`, the
 * ordinary hidden state that find skips — and hands back the `beforematch` the
 * browser fires just before scrolling to a hit, which is what re-opens the
 * panel around it.
 */

import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import { cn } from '@/react-app/design-system'
import { UntilFound } from './find/until-found'

export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  className,
}: {
  /** The always-visible line. Rendered inside the toggle button. */
  summary: ReactNode
  children: ReactNode
  defaultOpen?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  const bodyId = useId()

  return (
    <div className={cn('min-w-0', className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md py-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <span
          aria-hidden="true"
          className={cn(
            'inline-block w-3 shrink-0 text-center text-[10px] text-ink-3 transition-transform duration-150',
            open && 'rotate-90',
          )}
        >
          ▶
        </span>
        <span className="min-w-0 flex-1">{summary}</span>
      </button>
      <UntilFound
        open={open}
        // The browser found a match in here and is about to scroll to it.
        onReveal={() => setOpen(true)}
        id={bodyId}
        className="mt-1 ml-4 min-w-0"
      >
        {children}
      </UntilFound>
    </div>
  )
}

/**
 * Monospace payload inside a disclosure: tool arguments, tool output, a
 * subtask's answer.
 *
 * Height-capped and scrollable rather than clipped. The caller caps the *text*
 * (`capToolOutput`) before it gets here; this caps the space it may occupy.
 */
export function PayloadBlock({
  label,
  body,
  note,
}: {
  label: string
  body: string
  /** What was left out, when something was. */
  note?: string | null
}) {
  return (
    <div className="mt-1.5 min-w-0">
      <div className="text-[10px] font-medium tracking-wide text-ink-3 uppercase">{label}</div>
      <pre className="mt-1 max-h-64 overflow-auto rounded-md border border-border bg-surface-2 px-2 py-1.5 font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink-2">
        {body}
      </pre>
      {note ? <div className="mt-0.5 text-[10px] text-ink-3">{note}</div> : null}
    </div>
  )
}
