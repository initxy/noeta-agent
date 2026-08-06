/**
 * The list that opens above the composer for `/` and `@`.
 *
 * One component for both triggers because they differ in exactly two ways, and
 * both are props: what a row means, and whether an empty result renders
 * anything. The slash menu always renders a body — "no commands" is an answer,
 * and a menu that silently fails to appear reads as a broken keystroke. The
 * mention menu renders nothing, because an empty file search is the normal
 * state of typing a word that happens to start with `@`.
 *
 * `onMouseDown` is prevented on the list: without it the editor blurs before
 * the click lands, the selection is gone, and the commit writes into nothing.
 */

import { cn } from '@/react-app/design-system'
import type { Suggestion } from './suggestions'

export function SuggestionMenu({
  label,
  items,
  activeIndex,
  emptyMessage,
  onHover,
  onSelect,
}: {
  label: string
  items: readonly Suggestion[]
  activeIndex: number
  /** Rendered when there is nothing to show; null hides the menu entirely. */
  emptyMessage: string | null
  onHover: (index: number) => void
  onSelect: (item: Suggestion) => void
}) {
  if (items.length === 0 && emptyMessage === null) return null

  return (
    <div className="absolute bottom-full left-0 right-0 z-30 mb-1">
      <ul
        role="listbox"
        aria-label={label}
        className="max-h-64 overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-card"
        onMouseDown={(event) => event.preventDefault()}
      >
        {items.length === 0 ? (
          <li className="px-2 py-1.5 text-xs text-ink-3">{emptyMessage}</li>
        ) : (
          items.map((item, index) => (
            <li key={item.id}>
              <button
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                tabIndex={-1}
                onMouseEnter={() => onHover(index)}
                onClick={() => onSelect(item)}
                className={cn(
                  'flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left',
                  index === activeIndex ? 'bg-surface-2 text-ink' : 'text-ink-2',
                )}
              >
                <span className="w-full truncate text-xs font-medium">{item.label}</span>
                {item.description === undefined ? null : (
                  <span className="w-full truncate text-[11px] text-ink-3">
                    {item.description}
                  </span>
                )}
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  )
}
