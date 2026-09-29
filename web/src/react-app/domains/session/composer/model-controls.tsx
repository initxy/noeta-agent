/**
 * The model and effort picker: one popover, not two selects.
 *
 * The composer used to carry two bare `<select>`s side by side; now a single
 * subtle trigger shows the current model and effort, and clicking it opens an
 * upward panel with a **Model** list and a **Reasoning** list. Fewer controls
 * on the bar, and the two choices that belong together are chosen together.
 *
 * What must stay correct is the *values*: the backend rejects an unknown model
 * or an effort outside that model's ladder with a 422, so the panel only offers
 * `selection.efforts` — the ladder `resolveSelection` already narrowed to the
 * chosen model, in the backend's intensity order.
 *
 * `disabled` means **steering**, and it means nothing else. A turn already
 * running keeps this live — picking the model for the *next* turn while the
 * current one works is ordinary — but a steer joins the turn in flight, and
 * swapping its model underneath it is the one change that cannot mean what it
 * looks like. While steering the trigger is inert.
 *
 * The panel is a plain button + panel with an outside-click catcher rather than
 * a headless menu package, matching `send-controls.tsx`: the composer already
 * owns one such menu, and a second dependency to render a list of radios is not
 * worth the weight.
 */

import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import type { Model } from '@/app/types'
import { cn } from '@/react-app/design-system'
import type { ResolvedSelection } from '../state/model-selection'

function Row({
  selected,
  label,
  onSelect,
}: {
  selected: boolean
  label: string
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs',
        'outline-none focus-visible:ring-2 focus-visible:ring-accent',
        selected ? 'text-ink' : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
      )}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {selected ? <Check className="size-3.5 shrink-0 text-accent" aria-hidden="true" /> : null}
    </button>
  )
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="px-2 pt-1.5 pb-0.5 text-[10px] font-medium tracking-wide text-ink-3 uppercase">
      {children}
    </div>
  )
}

export function ModelControls({
  models,
  selection,
  disabled = false,
  onModel,
  onEffort,
}: {
  models: readonly Model[]
  selection: ResolvedSelection
  /** True only while steering. */
  disabled?: boolean
  onModel: (modelId: string) => void
  onEffort: (effort: string) => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  // A click outside dismisses the panel. `mousedown` so it is gone before the
  // click lands on whatever was under it.
  useEffect(() => {
    if (!open) return
    const dismiss = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', dismiss)
    return () => document.removeEventListener('mousedown', dismiss)
  }, [open])

  // Steering freezes the picker: a panel left open when the turn it belongs to
  // starts would let the model be swapped under the run.
  useEffect(() => {
    if (disabled && open) setOpen(false)
  }, [disabled, open])

  if (selection.model === null) {
    // No catalogue: either it has not loaded or `models.json` is empty. Sending
    // still works — the backend applies its own default — so this says so
    // rather than blocking the composer.
    return <span className="text-xs text-ink-3">Default model</span>
  }

  const summary =
    selection.efforts.length > 0 && selection.effort !== null
      ? `${selection.model.label} · ${selection.effort}`
      : selection.model.label

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        // Keep the accessible name "Model": it is what the composer's tests and
        // any future automation reach the picker by.
        aria-label="Model"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'flex h-7 max-w-[14rem] items-center gap-1.5 rounded-md border px-2 text-xs',
          'outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent',
          'disabled:opacity-50',
          open
            ? 'border-border-strong bg-surface-2 text-ink'
            : 'border-transparent text-ink-2 hover:border-border hover:bg-surface-2 hover:text-ink',
        )}
      >
        <span className="min-w-0 truncate">{summary}</span>
        <ChevronDown className="size-3 shrink-0 text-ink-3" aria-hidden="true" />
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Model and reasoning"
          className="absolute bottom-full left-0 z-30 mb-1.5 min-w-52 rounded-lg border border-border bg-surface p-1 shadow-card"
        >
          <SectionLabel>Model</SectionLabel>
          {models.map((model) => (
            <Row
              key={model.id}
              selected={model.id === selection.model?.id}
              label={model.label}
              onSelect={() => onModel(model.id)}
            />
          ))}

          {selection.efforts.length > 0 ? (
            <>
              <SectionLabel>Reasoning</SectionLabel>
              {selection.efforts.map((effort) => (
                <Row
                  key={effort}
                  selected={effort === selection.effort}
                  label={effort}
                  onSelect={() => onEffort(effort)}
                />
              ))}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
