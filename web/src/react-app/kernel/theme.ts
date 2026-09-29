/**
 * The light/dark theme, as a fact about the `<html>` class.
 *
 * The `dark:` variant keys on the `.dark` class (see `index.css`), and
 * `index.html` ships that class so the workbench paints dark before a single
 * line of JS runs. This module is the *deliberate* toggle the CSS comment
 * promised: it reconciles the pre-hydration default with a persisted choice and
 * flips the class on demand.
 *
 * State lives on the document, not in React: the class is what the whole
 * stylesheet reads, so a store mirroring it would be a second copy of the one
 * true bit. Components subscribe through `useTheme`, which listens for the
 * custom event this module dispatches on every change.
 *
 * Persistence reuses the route-memory storage helpers, so a browser that
 * refuses `localStorage` (Safari private mode, SSR, tests) degrades to
 * "remembers nothing" rather than throwing.
 */

import { readStored, writeStored } from './route-memory'
import { useSyncExternalStore } from 'react'

export type Theme = 'light' | 'dark'

const THEME_KEY = 'noeta.theme'
const THEME_EVENT = 'noeta:theme'

/** The shipped default, matching `index.html`'s `class="dark"`. */
const DEFAULT_THEME: Theme = 'dark'

function documentTheme(): Theme {
  if (typeof document === 'undefined') return DEFAULT_THEME
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

/** Read the persisted choice, falling back to whatever the document ships. */
export function readTheme(): Theme {
  const stored = readStored(THEME_KEY)
  if (stored === 'light' || stored === 'dark') return stored
  return documentTheme()
}

function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle('dark', theme === 'dark')
}

/**
 * Reconcile the document with the persisted choice, once, on boot. Called from
 * the shell so a returning user sees their theme rather than the shipped
 * default flashing to it.
 */
export function initTheme(): void {
  applyTheme(readTheme())
}

/** Flip and persist. The custom event is what `useTheme` subscribers hear. */
export function setTheme(theme: Theme): void {
  applyTheme(theme)
  writeStored(THEME_KEY, theme)
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(THEME_EVENT))
  }
}

export function toggleTheme(): void {
  setTheme(documentTheme() === 'dark' ? 'light' : 'dark')
}

/** Subscribe to the current theme. Re-renders on every `setTheme`. */
export function useTheme(): Theme {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === 'undefined') return () => {}
      window.addEventListener(THEME_EVENT, onChange)
      return () => window.removeEventListener(THEME_EVENT, onChange)
    },
    documentTheme,
    () => DEFAULT_THEME,
  )
}
