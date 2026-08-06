/**
 * The plan, pulled out of the scroll.
 *
 * A turn's checklist used to render as a row inside the process fold, where it
 * scrolled away with everything else. It is the one piece of "what is the agent
 * doing" a reader wants kept in view, so it is docked here above the composer
 * instead — collapsed to a progress line by default, expandable to the full
 * list.
 *
 * Presentational: it takes the latest `TodosItem` (or null) and renders. The
 * "latest" selection is `useLatestTodos` in the conversation store; this
 * component decides nothing about which plan to show.
 */

import { useEffect, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { TodosItem } from '@/app/fold'
import type { TodoStatus } from '@/app/types'
import { cn } from '@/react-app/design-system'

const GLYPH: Record<TodoStatus, string> = {
  pending: '○',
  in_progress: '◔',
  completed: '●',
}

export function TodoStrip({ todos }: { todos: TodosItem | null }) {
  const [open, setOpen] = useState(false)

  const list = todos?.todos ?? []
  const total = list.length
  const done = list.filter((todo) => todo.status === 'completed').length
  const current = list.find((todo) => todo.status === 'in_progress') ?? null
  const allDone = total > 0 && done === total

  // A finished plan folds itself away: once every item is done, the strip has
  // nothing left to keep in view and an expanded checklist is just noise.
  useEffect(() => {
    if (allDone) setOpen(false)
  }, [allDone])

  if (total === 0) return null

  return (
    <div className="shrink-0 px-4 pt-2">
      <div className="mx-auto w-full max-w-[46rem]">
        <div className="overflow-hidden rounded-xl border border-border bg-surface">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <ChevronRight
              aria-hidden="true"
              className={cn('size-3.5 shrink-0 text-ink-3 transition-transform', open && 'rotate-90')}
            />
            <span className="shrink-0 text-[11px] font-medium tracking-wide text-ink-3 uppercase">
              Tasks
            </span>
            <span className="shrink-0 text-xs tabular-nums text-ink-3">
              {done}/{total}
            </span>
            {/* A mini progress bar: filled with the accent, quiet grey once the
                whole plan is done. */}
            <span
              aria-hidden="true"
              className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-surface-3"
            >
              <span
                className={cn('block h-full rounded-full', allDone ? 'bg-ink-3' : 'bg-accent')}
                style={{ inlineSize: `${Math.round((done / total) * 100)}%` }}
              />
            </span>
            {!open && current ? (
              <span className="min-w-0 flex-1 truncate text-xs text-ink-2">{current.content}</span>
            ) : (
              <span className="flex-1" />
            )}
          </button>

          {open ? (
            <ul className="flex max-h-48 flex-col gap-0.5 overflow-y-auto border-t border-border px-3 py-2">
              {list.map((todo) => (
                <li key={todo.id} className="flex items-baseline gap-1.5 text-xs">
                  <span
                    aria-hidden="true"
                    className={cn(
                      'shrink-0',
                      todo.status === 'completed' ? 'text-accent' : 'text-ink-3',
                    )}
                  >
                    {GLYPH[todo.status]}
                  </span>
                  <span
                    className={cn(
                      'min-w-0',
                      todo.status === 'completed' ? 'text-ink-3 line-through' : 'text-ink-2',
                      todo.status === 'in_progress' && 'text-ink',
                    )}
                  >
                    {todo.content}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </div>
  )
}
