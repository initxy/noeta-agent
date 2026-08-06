/**
 * A centered modal dialog.
 *
 * The overlay idiom is the command palette's, lifted into a primitive so a
 * dialog is built once rather than re-hand-rolled per surface (the design
 * system's docstring anticipated this). It owns exactly the behaviour every
 * modal must get right and nothing about what it contains:
 *
 * - **Click outside closes.** `onMouseDown` on the backdrop, guarded by
 *   `target === currentTarget` so a drag that ends on the backdrop after
 *   starting inside the card does not dismiss it.
 * - **Escape closes**, on a capture-phase handler on the card, so it is caught
 *   before anything inside gets to treat Escape as its own.
 * - **It renders nothing when closed.** No hidden node holding focus or state.
 *
 * What it does *not* do is trap focus or restore it on close — the surfaces
 * that use it are short forms, and the browser's own tab order is enough. A
 * later phase's `@base-ui/react` dialog can take that over without any caller
 * changing.
 */

import { useEffect } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { CloseButton } from './close-button'
import { cn } from './cn'

export function Modal({
  open,
  onClose,
  title,
  children,
  className,
}: {
  open: boolean
  onClose: () => void
  /** Accessible name for the dialog, and the heading shown at its top. */
  title: string
  children: ReactNode
  className?: string
}) {
  // A body-scroll lock while open: a dialog the page can scroll behind reads as
  // not-really-modal, and the scroll position is lost when it closes.
  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [open])

  if (!open) return null

  const onKeyDownCapture = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[12vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDownCapture={onKeyDownCapture}
        className={cn(
          'flex w-full max-w-lg flex-col rounded-lg border border-border bg-surface shadow-card',
          className,
        )}
      >
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          <CloseButton onClick={onClose} />
        </div>
        <div className="min-h-0 overflow-auto p-5">{children}</div>
      </div>
    </div>
  )
}
