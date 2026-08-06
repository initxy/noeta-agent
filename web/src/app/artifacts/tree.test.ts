import { describe, expect, it } from 'vitest'
import { buildTree } from './tree'
import type { TreeDir, TreeFile, TreeNode } from './tree'
import type { WorkspaceFile } from '../types/wire'

/**
 * The folding rule, pinned from every direction it can go wrong: implicit
 * parents get materialised, directories sort before files, a rung sorts by
 * locale, and a stray leading slash never eats a file.
 */

const file = (path: string, over: Partial<WorkspaceFile> = {}): WorkspaceFile => ({
  path,
  size: 10,
  mtime: 1,
  ...over,
})

const dir = (node: TreeNode): TreeDir => {
  if (node.type !== 'dir') throw new Error(`expected dir, got file ${node.path}`)
  return node
}

const names = (nodes: readonly TreeNode[]): string[] => nodes.map((n) => n.name)

describe('buildTree', () => {
  it('returns an empty tree for no files', () => {
    expect(buildTree([])).toEqual([])
  })

  it('keeps a root-level file at the top', () => {
    const tree = buildTree([file('README.md')])
    expect(tree).toHaveLength(1)
    expect(tree[0]).toMatchObject({ type: 'file', name: 'README.md', path: 'README.md', size: 10 })
  })

  it('materialises implicit parent directories', () => {
    const tree = buildTree([file('a/b/c.ts')])
    const a = dir(tree[0])
    expect(a).toMatchObject({ type: 'dir', name: 'a', path: 'a/' })
    const b = dir(a.children[0])
    expect(b).toMatchObject({ type: 'dir', name: 'b', path: 'a/b/' })
    expect(b.children[0]).toMatchObject({ type: 'file', name: 'c.ts', path: 'a/b/c.ts' })
  })

  it('groups siblings under one materialised directory', () => {
    const tree = buildTree([file('src/a.ts'), file('src/b.ts')])
    expect(tree).toHaveLength(1)
    const src = dir(tree[0])
    expect(names(src.children)).toEqual(['a.ts', 'b.ts'])
  })

  it('sorts directories before files, then by locale within a rung', () => {
    const tree = buildTree([
      file('zeta.ts'),
      file('alpha.ts'),
      file('lib/x.ts'),
      file('app/y.ts'),
    ])
    // dirs (app, lib) first in locale order, then files (alpha, zeta).
    expect(names(tree)).toEqual(['app', 'lib', 'alpha.ts', 'zeta.ts'])
  })

  it('does not drop a file whose path carries a leading slash', () => {
    const tree = buildTree([file('/a/b.ts')])
    const a = dir(tree[0])
    expect(a.path).toBe('a/')
    expect(a.children[0]).toMatchObject({ type: 'file', name: 'b.ts', path: 'a/b.ts' })
  })

  it('carries size and mtime through onto the leaf', () => {
    const tree = buildTree([file('data/report.csv', { size: 2048, mtime: 999 })])
    const leaf = dir(tree[0]).children[0] as TreeFile
    expect(leaf).toMatchObject({ size: 2048, mtime: 999 })
  })
})
