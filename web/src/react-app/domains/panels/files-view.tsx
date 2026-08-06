/**
 * The file browser: the project directory as a tree, and a read-only preview of
 * whatever is selected. This *is* the panel's file view — there is one way to
 * look at a file, tree on the left and preview on the right, and every file the
 * user opens (from the tree, or from an artifact the dock points at) lands here.
 *
 * Reads the host-side listing rather than the container, so it works for a
 * `local` project (which has no container) and for a `sandbox` project whose
 * container is stopped. Under D2 that directory is shared by every session of
 * the project, which is stated here rather than left to be discovered — a user
 * seeing another session's files and thinking they are looking at a bug is a
 * worse outcome than one line of copy.
 *
 * Selection is a plain workspace-relative path. It is **controlled when the dock
 * passes `selectedPath`** — so clicking an artifact the conversation produced
 * selects it in the tree — and falls back to local state otherwise, which keeps
 * the component self-contained for any caller that just wants a browser.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, File, Folder, FolderOpen, PanelLeft, PanelLeftClose } from 'lucide-react'
import { CenteredNote, cn } from '@/react-app/design-system'
import { fileRawUrl } from '@/app/api/files'
import { buildTree } from '@/app/artifacts/tree'
import type { TreeNode } from '@/app/artifacts/tree'
import { targetFromWorkspaceFile } from '@/app/artifacts/resolve'
import { formatBytes } from '@/app/format/bytes'
import { readStored, writeStored } from '@/react-app/kernel/route-memory'
import { useArtifactText, useWorkspaceFiles } from './queries/artifact-queries'
import { FilePreview, isTextPreview } from './renderers/file-preview'
import { useTreeWidth } from './state/use-tree-width'

/** Whether the tree column is hidden, so the preview fills the pane. A reader
 *  who collapsed it wants it collapsed next time too — persisted as `'1'`/absent,
 *  exactly like the sidebar's own collapse (see `shell/sidebar.tsx`). */
const TREE_HIDDEN_KEY = 'noeta.files.tree.collapsed'

export function FilesView({
  sessionId,
  selectedPath,
  onSelect,
}: {
  sessionId: string
  /** Controlled selection, a workspace-relative path. Omitted = the view owns it. */
  selectedPath?: string | null
  /** Notified on every selection, so a controlling parent can track it. */
  onSelect?: (path: string) => void
}) {
  const query = useWorkspaceFiles(sessionId, true)
  const files = useMemo(() => query.data ?? [], [query.data])
  const tree = useMemo(() => buildTree(files), [files])

  const containerRef = useRef<HTMLDivElement>(null)
  const treeWidth = useTreeWidth(containerRef)

  // Whether the tree column is hidden. A workspace preference, not a per-session
  // fact, so it persists across sessions and reloads (unlike the selection,
  // which is a path in *this* session's tree and resets on session change).
  const [treeHidden, setTreeHidden] = useState(() => readStored(TREE_HIDDEN_KEY) === '1')
  const toggleTree = () =>
    setTreeHidden((hidden) => {
      const next = !hidden
      writeStored(TREE_HIDDEN_KEY, next ? '1' : null)
      return next
    })

  // Selection is controlled when the parent passes `selectedPath`, else local.
  // A parent that only wants a browser needs no wiring; the dock, which drives
  // selection from artifact clicks, passes both.
  const [internalSelected, setInternalSelected] = useState<string | null>(null)
  const selected = selectedPath !== undefined ? selectedPath : internalSelected
  const select = (path: string) => {
    setInternalSelected(path)
    onSelect?.(path)
  }
  // Directories default to open, so we track the ones the user *collapsed*
  // rather than the ones they opened — a new directory the agent writes is
  // then visible without a click.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  // The tree's collapse set is a path map for *this* session; another session's
  // tree has different paths, so it resets when the session changes. Selection
  // is either the parent's concern (controlled) or reset by the same parent, so
  // only the uncontrolled fallback is cleared here.
  useEffect(() => {
    setInternalSelected(null)
    setCollapsed(new Set())
  }, [sessionId])

  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  const selectedFile = selected === null ? null : files.find((file) => file.path === selected) ?? null
  const target = selectedFile ? targetFromWorkspaceFile(selectedFile) : null
  const wantsText = target !== null && isTextPreview(target)
  const text = useArtifactText(sessionId, target && wantsText ? target.value : null)

  if (query.isLoading) return <CenteredNote>Loading files…</CenteredNote>
  if (query.isError) return <CenteredNote>{query.error.message}</CenteredNote>
  if (files.length === 0) {
    return <CenteredNote>Nothing in the project directory yet.</CenteredNote>
  }

  return (
    <div ref={containerRef} className="relative flex h-full min-h-0">
      {treeHidden ? (
        // Collapsed: the preview fills the pane and a single control brings the
        // tree back — mirroring the sidebar's collapsed strip. Pinned to the
        // pane's top-left over the preview, so it never shifts the content.
        <button
          type="button"
          onClick={toggleTree}
          title="Show file tree"
          aria-label="Show file tree"
          aria-expanded={false}
          className="absolute left-2 top-2 z-10 rounded-md border border-border bg-surface p-1.5 text-ink-3 shadow-card outline-none transition-colors hover:bg-surface-2 hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"
        >
          <PanelLeft className="size-4" aria-hidden="true" />
        </button>
      ) : (
        <>
          <div
            className="flex shrink-0 flex-col border-r border-border"
            style={{ width: treeWidth.width }}
          >
            <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border pl-3 pr-1.5">
              <span className="min-w-0 flex-1 truncate text-xs text-ink-3">Project directory</span>
              <button
                type="button"
                onClick={toggleTree}
                title="Hide file tree"
                aria-label="Hide file tree"
                aria-expanded
                className="shrink-0 rounded-md p-1 text-ink-3 outline-none transition-colors hover:bg-surface-2 hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"
              >
                <PanelLeftClose className="size-3.5" aria-hidden="true" />
              </button>
            </div>
            <ul className="min-h-0 flex-1 overflow-auto p-1">
              {tree.map((node) => (
                <TreeRow
                  key={node.path}
                  node={node}
                  depth={0}
                  collapsed={collapsed}
                  onToggle={toggle}
                  selected={selected}
                  onSelect={select}
                />
              ))}
            </ul>
          </div>

          {/* The tree/preview splitter: a slim grab strip straddling the tree's
              right border. Style mirrors the panel dock's resize handle so the two
              drags feel like one gesture vocabulary. */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize file tree"
            onPointerDown={treeWidth.onHandlePointerDown}
            className={cn(
              'absolute inset-y-0 z-10 -ml-1 w-2 cursor-col-resize',
              'transition-colors hover:bg-accent/25',
              treeWidth.dragging && 'bg-accent/40',
            )}
            style={{ left: treeWidth.width }}
          />
        </>
      )}

      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        {target ? (
          <FilePreview
            target={target}
            rawUrl={fileRawUrl(sessionId, target.value)}
            text={text}
            wantsText={wantsText}
          />
        ) : (
          <CenteredNote>Select a file to preview it.</CenteredNote>
        )}
      </div>
    </div>
  )
}

/**
 * One tree row, recursive. A directory toggles open/closed on click; a file
 * selects. Indentation grows with depth; the chevron placeholder on a file row
 * keeps names aligned with the directory rows above them.
 */
function TreeRow({
  node,
  depth,
  collapsed,
  onToggle,
  selected,
  onSelect,
}: {
  node: TreeNode
  depth: number
  collapsed: Set<string>
  onToggle: (path: string) => void
  selected: string | null
  onSelect: (path: string) => void
}) {
  const pad = 8 + depth * 14

  if (node.type === 'dir') {
    const open = !collapsed.has(node.path)
    return (
      <li>
        <button
          type="button"
          onClick={() => onToggle(node.path)}
          title={node.path}
          className="flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left transition-colors hover:bg-surface-2"
          style={{ paddingLeft: pad }}
        >
          <ChevronRight
            className={cn('h-3 w-3 shrink-0 text-ink-3 transition-transform', open && 'rotate-90')}
          />
          {open ? (
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-ink-3" />
          ) : (
            <Folder className="h-3.5 w-3.5 shrink-0 text-ink-3" />
          )}
          <span className="min-w-0 flex-1 truncate text-xs text-ink">{node.name}</span>
        </button>
        {open ? (
          <ul>
            {node.children.map((child) => (
              <TreeRow
                key={child.path}
                node={child}
                depth={depth + 1}
                collapsed={collapsed}
                onToggle={onToggle}
                selected={selected}
                onSelect={onSelect}
              />
            ))}
          </ul>
        ) : null}
      </li>
    )
  }

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(node.path)}
        title={node.path}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left transition-colors',
          selected === node.path ? 'bg-accent-soft' : 'hover:bg-surface-2',
        )}
        style={{ paddingLeft: pad }}
      >
        <span className="h-3 w-3 shrink-0" aria-hidden />
        <File className="h-3.5 w-3.5 shrink-0 text-ink-3" />
        <span className="min-w-0 flex-1 truncate text-xs text-ink">{node.name}</span>
        <span className="shrink-0 text-[10px] text-ink-3 tabular-nums">{formatBytes(node.size)}</span>
      </button>
    </li>
  )
}
