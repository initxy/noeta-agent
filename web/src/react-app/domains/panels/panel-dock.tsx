/**
 * The panel dock: one file browser, the artifacts this conversation produced,
 * and the sandbox preview channels — all in one pane, no tabs.
 *
 * The derivation pipeline, top to bottom, is the whole of D12:
 *
 * ```
 * transcript ──deriveArtifactCandidates──▶ candidates (guesses)
 *                                            │ fingerprint
 *                                            ▼
 *                   POST /sessions/{id}/artifacts/resolve  (the server decides)
 *                                            ▼
 *                                 targets (exists/size/updatedAt/preview)
 *                                            ├─▶ syncTargets → the artifacts menu
 *                                            └─▶ freshness → content invalidated
 * ```
 *
 * The transcript arrives as a **prop**, not from a store. The conversation
 * lives in a sibling domain and the layering forbids reaching into it — which
 * is the right constraint here rather than an obstacle: the derivation engine
 * is a pure function of a list of items, so a panel that takes the list is a
 * panel that can be tested, reused by the workbench, and mounted against any
 * branch's projection without knowing what a branch is.
 *
 * **One way to look at a file.** There is a single file view — tree on the
 * left, preview on the right (`FilesView`) — and it is the dock's body. There
 * are no artifact tabs and no full-width single-file view: an artifact the
 * conversation produced is opened by *selecting its path in the tree*, so it
 * reads the same however it was reached. The top control switches only between
 * the file browser and the sandbox channels (Preview / Terminal), which are
 * whole different surfaces rather than files.
 *
 * **Nothing auto-opens.** The panel opens empty — no file selected — and waits
 * for a click, in the tree or in the artifacts menu.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button, CloseButton, cn } from '@/react-app/design-system'
import { deriveArtifactCandidates } from '@/app/artifacts/derive'
import { isCollectibleArtifact } from '@/app/artifacts/resolve'
import type { ArtifactTarget } from '@/app/types/artifacts'
import type { ConversationItem } from '@/app/fold'
import { BrowserView } from './browser-view'
import { FilesView } from './files-view'
import { TerminalView } from './terminal/terminal-view'
import {
  useArtifactFreshness,
  usePreviewChannel,
  useResolvedArtifacts,
} from './queries/artifact-queries'
import { panelActions, usePanelTargets } from './state/panel-tab-store'

/** Which surface the dock is showing: the file browser, or one of the sandbox
 *  channels. `files` is the only one that always exists; the channels appear on
 *  the toggle only when the session has a container. */
type PanelView = 'files' | 'preview' | 'terminal'

export interface PanelDockProps {
  sessionId: string
  /** The branch's transcript, as the conversation fold projects it. */
  items: readonly ConversationItem[]
  /** The project directory, so absolute tool output resolves to it. */
  workspaceRoot: string | null
  onClose?: () => void
  /** The resize handle's pointer-down, from `usePanelWidth`. Omitted = no handle. */
  onResizePointerDown?: (event: ReactPointerEvent) => void
  /** Whether a resize drag is in flight — the handle stays highlighted. */
  resizing?: boolean
  className?: string
}

export function PanelDock({
  sessionId,
  items,
  workspaceRoot,
  onClose,
  onResizePointerDown,
  resizing = false,
  className,
}: PanelDockProps) {
  const candidates = useMemo(
    () => deriveArtifactCandidates(items, { workspaceRoot }),
    [items, workspaceRoot],
  )
  const resolved = useResolvedArtifacts(sessionId, candidates)
  const preview = usePreviewChannel(sessionId)
  const noteFreshness = useArtifactFreshness(sessionId)

  const targets = usePanelTargets(sessionId)
  const previousTargets = useRef<readonly ArtifactTarget[]>([])

  useEffect(() => {
    const next = resolved.data
    if (!next) return
    noteFreshness(previousTargets.current, next)
    previousTargets.current = next
    panelActions().syncTargets(sessionId, next)
  }, [noteFreshness, resolved.data, sessionId])

  const collectible = targets.filter(isCollectibleArtifact)
  const channel = preview.data ?? null

  const [view, setView] = useState<PanelView>('files')
  // Which file the browser shows, driven here so an artifact click selects it
  // in the tree. A path in this session's directory, reset when the session
  // changes — the same rule the tree's own collapse set follows.
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  useEffect(() => setSelectedPath(null), [sessionId])

  // A channel can vanish (a container stopped mid-session); if the dock was
  // showing it, fall back to the file browser rather than a dead surface.
  useEffect(() => {
    if (channel === null && view !== 'files') setView('files')
  }, [channel, view])

  // Selecting an artifact is selecting its path in the tree, on the file view.
  const openArtifact = (target: ArtifactTarget) => {
    setSelectedPath(target.value)
    setView('files')
  }

  return (
    <section
      data-testid="panel-dock"
      className={cn(
        'relative flex h-full min-h-0 flex-col border-l border-border bg-surface',
        className,
      )}
    >
      {/* The resize handle: a slim grab strip straddling the left border. It is
          only rendered when the caller wired one up (the workbench pane does;
          a non-resizable mount can omit it). */}
      {onResizePointerDown ? (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize panel"
          onPointerDown={onResizePointerDown}
          className={cn(
            'absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize',
            'transition-colors hover:bg-accent/25',
            resizing && 'bg-accent/40',
          )}
        />
      ) : null}

      {/* One 52px bar, aligned with the sidebar brand header and the pane header
          so the top border reads as a single hairline across all three columns.
          The surface toggles are a segmented control; the artifacts menu and the
          close button sit at the trailing edge. */}
      <div className="flex h-[52px] shrink-0 items-center gap-2 border-b border-border px-3">
        <div className="flex items-center gap-0.5 rounded-lg bg-surface-2 p-0.5">
          <ViewButton active={view === 'files'} onClick={() => setView('files')}>
            Files
          </ViewButton>
          {channel ? (
            <>
              <ViewButton active={view === 'preview'} onClick={() => setView('preview')}>
                Preview
              </ViewButton>
              <ViewButton active={view === 'terminal'} onClick={() => setView('terminal')}>
                Terminal
              </ViewButton>
            </>
          ) : null}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {collectible.length > 0 ? (
            <ArtifactsMenu targets={collectible} onOpen={openArtifact} />
          ) : null}
          {onClose ? <CloseButton onClick={onClose} aria-label="Close panel" /> : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {view === 'files' ? (
          <FilesView
            sessionId={sessionId}
            selectedPath={selectedPath}
            onSelect={setSelectedPath}
          />
        ) : view === 'terminal' ? (
          <TerminalView preview={channel} />
        ) : (
          <BrowserView preview={channel} />
        )}
      </div>
    </section>
  )
}

/** One segment of the surface toggle. */
function ViewButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: string
}) {
  return (
    <Button
      size="sm"
      variant="ghost"
      aria-pressed={active}
      onClick={onClick}
      className={active ? 'bg-surface text-ink shadow-card' : undefined}
    >
      {children}
    </Button>
  )
}

/**
 * The artifacts this conversation produced, as a menu.
 *
 * A menu rather than the tab-per-file it replaced: the files live in the tree
 * already, so this is a shortcut to the ones *this conversation* wrote, not a
 * second place they open. Picking one selects it in the tree.
 */
function ArtifactsMenu({
  targets,
  onOpen,
}: {
  targets: readonly ArtifactTarget[]
  onOpen: (target: ArtifactTarget) => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const dismiss = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', dismiss)
    return () => document.removeEventListener('mousedown', dismiss)
  }, [open])

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'flex h-7 items-center gap-1 rounded-md px-2 text-xs tabular-nums',
          'outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent',
          open ? 'bg-surface-2 text-ink' : 'text-ink-3 hover:bg-surface-2 hover:text-ink',
        )}
      >
        {targets.length} {targets.length === 1 ? 'artifact' : 'artifacts'}
        <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Artifacts this conversation produced"
          className="absolute right-0 top-full z-30 mt-1.5 max-h-80 w-64 overflow-auto rounded-lg border border-border bg-surface p-1 shadow-card"
        >
          {targets.map((target) => (
            <button
              key={target.id}
              type="button"
              role="menuitem"
              onClick={() => {
                onOpen(target)
                setOpen(false)
              }}
              className="flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-surface-2"
            >
              <span className="w-full truncate text-xs text-ink">{target.name}</span>
              <span className="w-full truncate font-mono text-[10px] text-ink-3">
                {target.value}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
