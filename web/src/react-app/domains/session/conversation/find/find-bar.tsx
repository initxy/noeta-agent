/**
 * The find bar: an input, a counter, and two steps.
 *
 * It floats over the transcript rather than pushing it, because a bar that
 * changes the layout re-flows every row the moment you open it — and the reader
 * opened it to look at something specific. The surface compensates with extra
 * top padding while the bar is open so it cannot cover the first row of a short
 * conversation.
 *
 * Keyboard: `Enter` next, `Shift+Enter` previous, `Escape` close. The arrow
 * buttons take `onMouseDown` prevention so clicking one does not steal focus
 * from the input — otherwise the next `Enter` goes nowhere.
 */

import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { ArrowDown, ArrowUp, X } from 'lucide-react'
import { cn } from '@/react-app/design-system'
import { MIN_QUERY_LENGTH } from './highlight'
import type { FindController } from './use-find'

export function FindBar({ find }: { find: FindController }) {
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Re-triggering the chord on an open bar re-focuses and selects, which is
  // what every other find bar does and what the nonce exists for.
  useEffect(() => {
    if (!find.open) return
    const input = inputRef.current
    if (input === null) return
    input.focus()
    input.select()
  }, [find.open, find.focusNonce])

  if (!find.open) return null

  const short = find.query.trim().length < MIN_QUERY_LENGTH
  const counter = short ? '' : find.matchCount === 0 ? 'No matches' : `${find.activeIndex + 1}/${find.matchCount}`

  return (
    <div
      className={cn(
        'absolute top-2 right-3 z-30 flex items-center gap-1 rounded-lg border border-border',
        'bg-surface/95 p-1 shadow-card backdrop-blur-md',
      )}
      data-testid="find-bar"
    >
      <input
        ref={inputRef}
        type="text"
        value={find.query}
        aria-label="Find in conversation"
        placeholder="Find"
        onChange={(event) => find.setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            find.close()
            return
          }
          if (event.key !== 'Enter') return
          // IME guard: an Enter that commits a composition is not a search.
          if (event.nativeEvent.isComposing) return
          event.preventDefault()
          event.stopPropagation()
          if (event.shiftKey) find.previous()
          else find.next()
        }}
        className={cn(
          'h-7 w-44 rounded-md bg-transparent px-2 text-sm text-ink outline-none',
          'placeholder:text-ink-3',
        )}
      />
      <span
        aria-live="polite"
        className={cn(
          'shrink-0 text-center text-[11px] tabular-nums text-ink-3',
          // Widened for the longest string so the bar does not resize as you
          // type past the last match.
          find.matchCount === 0 && !short ? 'min-w-20' : 'min-w-12',
        )}
      >
        {counter}
      </span>
      <StepButton label="Previous match" disabled={find.matchCount === 0} onClick={find.previous}>
        <ArrowUp className="size-3.5" aria-hidden="true" />
      </StepButton>
      <StepButton label="Next match" disabled={find.matchCount === 0} onClick={find.next}>
        <ArrowDown className="size-3.5" aria-hidden="true" />
      </StepButton>
      <StepButton label="Close find" disabled={false} onClick={find.close}>
        <X className="size-3.5" aria-hidden="true" />
      </StepButton>
    </div>
  )
}

function StepButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={cn(
        'flex size-7 shrink-0 items-center justify-center rounded-md text-ink-2',
        'hover:bg-surface-2 hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent',
      )}
    >
      {children}
    </button>
  )
}
