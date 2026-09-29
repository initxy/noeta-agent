/**
 * The command palette.
 *
 * Mounted by the shell layout, so every route gets it and later work adds
 * commands rather than a host.
 *
 * The one behaviour that is easy to get wrong, and the reason this file has a
 * mode at all: **Escape goes back a level before it closes.** A palette that
 * dismisses outright from inside a sub-view throws away the search the user
 * just typed *and* the view they were in, for a keystroke they meant as "undo
 * that step". Backspace on an empty box does the same thing, because that is
 * what the hand reaches for first.
 *
 * Ranking is `cmdk`'s own scorer over each item's `keywords`. Keywords rather
 * than the rendered title, because an item's title is one phrasing of it and
 * the words people actually type ("llm", "cmd", "shortcut") are not in it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Command } from 'cmdk'
import { ChevronLeft, FolderOpen, Keyboard, MessageSquare, Plus, Settings, Activity } from 'lucide-react'
import { HOME_ROUTE, projectSessionRoute, projectSettingsRoute, traceRoute } from '@/app/routes'
import { cn } from '@/react-app/design-system'
import { usePlatform } from '@/react-app/kernel/platform'
import { DEFAULT_SETTINGS_TAB } from '@/react-app/domains/settings/settings-route'
import { useProjectIndex } from '@/react-app/domains/project/project-index'
import { useSessionIndex } from '@/react-app/domains/session/session-index'
import { useCreateSession } from '@/react-app/domains/session/queries/session-queries'
import {
  SHORTCUTS,
  isImeComposing,
  matchShortcut,
  shortcutById,
  shortcutHint,
  shortcutsOwnedBy,
  type ShortcutBinding,
} from './shortcuts/shortcut-table'
import { useGlobalShortcuts } from './shortcuts/use-shortcuts'

type PaletteMode = 'root' | 'sessions' | 'projects' | 'shortcuts'

interface PaletteItem {
  id: string
  title: string
  /** Right-aligned context: a shortcut, a project name, a count. */
  meta?: string
  keywords: string[]
  icon?: typeof FolderOpen
  run: () => void
  /** A view switch, so selecting it must not close the palette. */
  keepsOpen?: boolean
}

const MODE_CHROME: Record<PaletteMode, { title: string; placeholder: string; empty: string }> = {
  root: {
    title: 'Actions',
    placeholder: 'Search actions…',
    empty: 'No matching action.',
  },
  sessions: {
    title: 'Sessions',
    placeholder: 'Search sessions…',
    empty: 'No matching session in this project.',
  },
  projects: {
    title: 'Projects',
    placeholder: 'Search projects…',
    empty: 'No matching project.',
  },
  shortcuts: {
    title: 'Keyboard shortcuts',
    placeholder: 'Search shortcuts…',
    empty: 'No matching shortcut.',
  },
}

function groupShortcuts(bindings: readonly ShortcutBinding[]): [string, ShortcutBinding[]][] {
  const groups = new Map<string, ShortcutBinding[]>()
  for (const binding of bindings) {
    const existing = groups.get(binding.group)
    if (existing === undefined) groups.set(binding.group, [binding])
    else existing.push(binding)
  }
  return [...groups.entries()]
}

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<PaletteMode>('root')
  const [query, setQuery] = useState('')
  const { isMac } = usePlatform()
  const navigate = useNavigate()
  const { projectId, sessionId } = useParams()

  const projects = useProjectIndex().projects
  const sessions = useSessionIndex(projectId ?? '').sessions
  // `mutate` rather than the result object: the object is new on every render
  // and would defeat every memo below it.
  const createSession = useCreateSession().mutate

  /** Switching view resets the search — a query typed for one list is noise in the next. */
  const goTo = useCallback((next: PaletteMode) => {
    setMode(next)
    setQuery('')
  }, [])

  const close = useCallback(() => setOpen(false), [])

  // Reopening always lands on the root view. Restoring the last sub-view would
  // mean the palette opens somewhere the user did not ask for.
  useEffect(() => {
    if (!open) {
      setMode('root')
      setQuery('')
    }
  }, [open])

  useGlobalShortcuts({
    'palette.toggle': () => setOpen((wasOpen) => !wasOpen),
    'shortcuts.help': () => {
      setOpen(true)
      goTo('shortcuts')
    },
  })

  const rootItems = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = []

    if (projectId !== undefined) {
      items.push({
        id: 'session.new',
        title: 'New session',
        icon: Plus,
        keywords: ['new', 'session', 'chat', 'conversation', 'start', 'create'],
        run: () =>
          createSession(
            { projectId },
            { onSuccess: (session) => navigate(projectSessionRoute(projectId, session.id)) },
          ),
      })
      items.push({
        id: 'session.goto',
        title: 'Go to session…',
        icon: MessageSquare,
        meta: `${sessions.length}`,
        keywords: ['session', 'sessions', 'open', 'switch', 'go', 'conversation'],
        keepsOpen: true,
        run: () => goTo('sessions'),
      })
    }

    items.push({
      id: 'project.goto',
      title: 'Switch project…',
      icon: FolderOpen,
      meta: `${projects.length}`,
      keywords: ['project', 'projects', 'workspace', 'switch', 'open', 'directory'],
      keepsOpen: true,
      run: () => goTo('projects'),
    })

    if (projectId !== undefined) {
      items.push({
        id: 'project.settings',
        title: 'Project settings',
        icon: Settings,
        keywords: ['settings', 'preferences', 'model', 'tier', 'sandbox', 'persona', 'config'],
        run: () => navigate(projectSettingsRoute(projectId, DEFAULT_SETTINGS_TAB)),
      })
    }

    if (sessionId !== undefined) {
      items.push({
        id: 'session.trace',
        title: 'Open the trace for this session',
        icon: Activity,
        keywords: ['trace', 'debug', 'envelope', 'raw', 'events', 'stream', 'inspect'],
        run: () => navigate(traceRoute(sessionId)),
      })
    }

    items.push({
      id: 'shortcuts.show',
      title: 'Keyboard shortcuts',
      icon: Keyboard,
      meta: shortcutHint(shortcutById('shortcuts.help'), isMac),
      keywords: ['keyboard', 'shortcut', 'shortcuts', 'keys', 'bindings', 'help'],
      keepsOpen: true,
      run: () => goTo('shortcuts'),
    })

    items.push({
      id: 'home',
      title: 'Go to the project list',
      icon: FolderOpen,
      keywords: ['home', 'projects', 'list', 'start', 'index'],
      run: () => navigate(HOME_ROUTE),
    })

    return items
  }, [projectId, sessionId, sessions.length, projects.length, isMac, createSession, navigate, goTo])

  const sessionItems = useMemo<PaletteItem[]>(() => {
    if (projectId === undefined) return []
    return sessions.map((session) => ({
      id: `session:${session.id}`,
      title: session.title || 'Untitled session',
      icon: MessageSquare,
      meta: session.id === sessionId ? 'Current' : undefined,
      keywords: [session.title, session.id],
      run: () => navigate(projectSessionRoute(projectId, session.id)),
    }))
  }, [projectId, sessionId, sessions, navigate])

  const projectItems = useMemo<PaletteItem[]>(
    () =>
      projects.map((project) => ({
        id: `project:${project.id}`,
        title: project.name,
        icon: FolderOpen,
        meta: project.id === projectId ? 'Current' : project.tier,
        keywords: [project.name, project.directory, project.tier],
        run: () => navigate(projectSessionRoute(project.id)),
      })),
    [projects, projectId, navigate],
  )

  const items =
    mode === 'root' ? rootItems : mode === 'sessions' ? sessionItems : mode === 'projects' ? projectItems : []

  /**
   * Escape and Backspace, in capture so they are decided before `cmdk` and
   * before anything below the overlay sees them.
   */
  const onKeyDownCapture = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // The IME guard, first and by stopping the event rather than by returning.
    // `cmdk` guards two of the three composition signals on its own root; the
    // third — the `"Process"` key — is exactly what some engines report when a
    // Chinese or Japanese candidate is confirmed, and letting that through
    // runs the highlighted command instead of committing the word.
    if (isImeComposing(event.nativeEvent)) {
      event.stopPropagation()
      return
    }

    const binding = matchShortcut(event.nativeEvent, shortcutsOwnedBy('palette'), { isMac })
    if (binding === null) return

    if (binding.id === 'palette.back') {
      event.preventDefault()
      // Stop here too: the composer arms its stop on Escape, and an Escape
      // aimed at the palette must never reach past it.
      event.stopPropagation()
      if (mode === 'root') close()
      else goTo('root')
      return
    }

    if (binding.id === 'palette.back-empty') {
      // Only when there is nothing left to delete, and only from a sub-view —
      // otherwise Backspace is just Backspace.
      if (mode === 'root' || query !== '') return
      event.preventDefault()
      goTo('root')
    }
  }

  const select = (item: PaletteItem) => {
    // A leaf closes first and acts second, so the action is never seen through
    // a palette that is still fading. A view switch keeps it open by design.
    if (item.keepsOpen !== true) close()
    item.run()
  }

  const chrome = MODE_CHROME[mode]

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[12vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <div
        onKeyDownCapture={onKeyDownCapture}
        className="w-full max-w-xl overflow-hidden rounded-lg border border-border bg-surface shadow-card"
      >
        {/* Remounting on a view change resets `cmdk`'s highlight to the first
            row; without it the new list opens with row 4 selected. */}
        <Command key={mode} label={chrome.title} loop>
          <div className="flex h-11 items-center gap-2 border-b border-border px-3">
            {mode === 'root' ? null : (
              <button
                type="button"
                onClick={() => goTo('root')}
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink"
              >
                <ChevronLeft size={15} />
                <span className="sr-only">Back</span>
              </button>
            )}
            <Command.Input
              autoFocus
              value={query}
              onValueChange={setQuery}
              placeholder={chrome.placeholder}
              className="h-full w-full bg-transparent text-sm text-ink outline-none placeholder:text-ink-3"
            />
          </div>

          <Command.List className="max-h-80 overflow-y-auto p-1">
            <Command.Empty className="px-3 py-6 text-center text-sm text-ink-3">
              {chrome.empty}
            </Command.Empty>

            {mode === 'shortcuts'
              ? groupShortcuts(SHORTCUTS).map(([group, bindings]) => (
                  <Command.Group
                    key={group}
                    heading={group}
                    className="px-1 py-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-ink-3 [&_[cmdk-group-heading]]:uppercase"
                  >
                    {bindings.map((binding) => (
                      <Command.Item
                        key={binding.id}
                        value={binding.id}
                        keywords={[binding.label, binding.group]}
                        // A reference list, not a menu: nothing here is
                        // runnable from the palette.
                        disabled
                        className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-ink-2"
                      >
                        <span className="min-w-0 flex-1 truncate">{binding.label}</span>
                        <kbd className="shrink-0 rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-ink-3">
                          {shortcutHint(binding, isMac)}
                        </kbd>
                      </Command.Item>
                    ))}
                  </Command.Group>
                ))
              : items.map((item) => {
                  const Icon = item.icon
                  return (
                    <Command.Item
                      key={item.id}
                      value={item.id}
                      keywords={item.keywords}
                      onSelect={() => select(item)}
                      className={cn(
                        'flex items-center gap-2 rounded-md px-2 py-2 text-sm text-ink-2',
                        'data-[selected=true]:bg-surface-2 data-[selected=true]:text-ink',
                      )}
                    >
                      {Icon ? <Icon size={15} className="shrink-0 text-ink-3" /> : null}
                      <span className="min-w-0 flex-1 truncate">{item.title}</span>
                      {item.meta !== undefined ? (
                        <span className="shrink-0 text-[11px] text-ink-3">{item.meta}</span>
                      ) : null}
                    </Command.Item>
                  )
                })}
          </Command.List>

          <div className="flex items-center gap-3 border-t border-border px-3 py-1.5 text-[11px] text-ink-3">
            <span>↑↓ to navigate</span>
            <span>↵ to run</span>
            <span>{mode === 'root' ? 'esc to close' : 'esc to go back'}</span>
          </div>
        </Command>
      </div>
    </div>
  )
}
