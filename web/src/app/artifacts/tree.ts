/**
 * The file tree: a flat listing folded into a nested directory structure.
 *
 * The file surface (`GET /sessions/{id}/files`) answers with a flat
 * `WorkspaceFile[]` — every path relative to the project root, no hierarchy.
 * The tree the panel draws is that list folded on `/`: a pure transform, kept
 * here rather than in the view so the folding rule (implicit parents, dirs
 * before files, CJK-friendly order) is one testable function instead of state
 * threaded through a recursive component.
 *
 * `buildTree` materialises the directories a path *implies* — `a/b/c.ts`
 * creates `a/` and `a/b/` even though neither is its own entry in the listing —
 * because a tree that only drew directories the server named would have gaps
 * exactly where the nesting is deepest.
 */

import type { WorkspaceFile } from '../types/wire'

export interface TreeFile {
  type: 'file'
  name: string
  /** Workspace-relative path, as the file API wants it. */
  path: string
  size: number
  mtime: number
}

export interface TreeDir {
  type: 'dir'
  name: string
  /** Virtual directory path, trailing `/` — the collapse-set key. */
  path: string
  children: TreeNode[]
}

export type TreeNode = TreeFile | TreeDir

/**
 * Flat `WorkspaceFile[]` → nested `TreeNode[]`.
 *
 * Sorted directories-first, then `localeCompare` within a rung — which orders
 * CJK names the way a reader expects rather than by code point. Root-level
 * nodes are the ones whose parent path is empty.
 */
export function buildTree(entries: readonly WorkspaceFile[]): TreeNode[] {
  const nodes = new Map<string, TreeNode>()

  // A path implies its ancestors; materialise them before attaching the file.
  const ensureDir = (dirPath: string) => {
    if (!dirPath || dirPath === '/') return
    const existing = nodes.get(dirPath)
    if (existing && existing.type === 'dir') return
    const slash = dirPath.lastIndexOf('/', dirPath.length - 2)
    const parentPath = slash < 0 ? '' : dirPath.slice(0, slash + 1)
    if (parentPath) ensureDir(parentPath)
    const name = dirPath.slice(parentPath.length, dirPath.length - 1)
    const dir: TreeDir = { type: 'dir', name, path: dirPath, children: [] }
    nodes.set(dirPath, dir)
    if (parentPath) {
      const parent = nodes.get(parentPath)
      if (parent?.type === 'dir') parent.children.push(dir)
    }
  }

  for (const entry of entries) {
    // A leading slash would make the top-level collector below read `/a/`'s
    // parent as `/` (truthy) and silently drop the file. The backend does not
    // emit such paths today; this normalises defensively regardless.
    const cleanPath = entry.path.replace(/^\/+/, '')
    const slash = cleanPath.lastIndexOf('/')
    const parentPath = slash < 0 ? '' : cleanPath.slice(0, slash + 1)
    const name = slash < 0 ? cleanPath : cleanPath.slice(slash + 1)
    if (!name) continue
    ensureDir(parentPath)
    const node: TreeFile = {
      type: 'file',
      name,
      path: cleanPath,
      size: entry.size,
      mtime: entry.mtime,
    }
    if (parentPath) {
      const parent = nodes.get(parentPath)
      if (parent?.type === 'dir') parent.children.push(node)
    } else {
      nodes.set(cleanPath, node)
    }
  }

  const top: TreeNode[] = []
  for (const node of nodes.values()) {
    const tail = node.type === 'dir' ? node.path.length - 2 : node.path.length - 1
    const slash = node.path.lastIndexOf('/', tail)
    const parentPath = slash < 0 ? '' : node.path.slice(0, slash + 1)
    if (!parentPath) top.push(node)
  }

  sortTree(top)
  return top
}

/** Directories first, then localeCompare within a rung. Recurses. */
function sortTree(nodes: TreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  for (const node of nodes) {
    if (node.type === 'dir') sortTree(node.children)
  }
}
