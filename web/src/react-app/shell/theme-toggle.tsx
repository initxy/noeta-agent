/**
 * The light/dark toggle, in the sidebar header.
 *
 * A single icon button that flips the document theme through `kernel/theme`.
 * The theme lives on the `<html>` class, not in a store, so this reads the
 * current value through `useTheme` and shows the icon of the mode it will
 * switch *to* — the conventional affordance (a moon means "go dark").
 */

import { Moon, Sun } from 'lucide-react'
import { toggleTheme, useTheme } from '@/react-app/kernel/theme'

export function ThemeToggle() {
  const theme = useTheme()
  const next = theme === 'dark' ? 'light' : 'dark'
  const Icon = theme === 'dark' ? Sun : Moon
  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      className="flex size-6 shrink-0 items-center justify-center rounded-md text-ink-3 outline-none hover:bg-surface-2 hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"
    >
      <Icon className="size-3.5" aria-hidden="true" />
    </button>
  )
}
