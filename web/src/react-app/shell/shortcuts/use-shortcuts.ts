/**
 * The global half of the shortcut table: one window listener, driven by the
 * table rather than by a chain of `if (event.key === …)`.
 *
 * One listener rather than one per binding, because ordering between separate
 * listeners is registration order — invisible, and it changes when a component
 * mounts a render earlier. Here the order is the table's, which is readable.
 *
 * Handlers are held in a ref so a re-render does not detach and reattach the
 * listener; the effect depends only on the platform, which does not change.
 */

import { useEffect, useRef } from 'react'
import { usePlatform } from '@/react-app/kernel/platform'
import {
  GLOBAL_SHORTCUTS,
  isEditableTarget,
  matchShortcut,
  type ShortcutId,
} from './shortcut-table'

export type ShortcutHandlers = Partial<Record<ShortcutId, () => void>>

export function useGlobalShortcuts(handlers: ShortcutHandlers): void {
  const { isMac } = usePlatform()
  const handlersRef = useRef(handlers)

  useEffect(() => {
    handlersRef.current = handlers
  })

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const binding = matchShortcut(event, GLOBAL_SHORTCUTS, {
        isMac,
        inEditable: isEditableTarget(event.target),
      })
      if (binding === null) return
      const handler = handlersRef.current[binding.id]
      // No handler is not a swallowed key: the binding stays unclaimed and the
      // browser's own behaviour survives, which is the honest outcome when the
      // surface that would answer it is not mounted.
      if (handler === undefined) return
      event.preventDefault()
      handler()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isMac])
}
