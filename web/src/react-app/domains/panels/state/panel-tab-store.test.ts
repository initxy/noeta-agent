import { beforeEach, describe, expect, it } from 'vitest'
import { panelActions, usePanelOpen, usePanelTabStore, usePanelTargets } from './panel-tab-store'
import { renderHook } from '@testing-library/react'
import type { ArtifactTarget } from '@/app/types/artifacts'

const target = (name: string, over: Partial<ArtifactTarget> = {}): ArtifactTarget => ({
  id: `file:reports/${name}`,
  kind: 'file',
  value: `reports/${name}`,
  name,
  preview: 'markdown',
  confidence: 95,
  reason: 'write tool metadata',
  exists: true,
  size: 10,
  updatedAt: 'a',
  ...over,
})

describe('the panel store', () => {
  beforeEach(() => {
    usePanelTabStore.setState({ targets: {}, open: {} })
  })

  it('keeps targets isolated per session', () => {
    panelActions().syncTargets('s1', [target('a.md')])
    panelActions().syncTargets('s2', [target('b.md')])

    const state = usePanelTabStore.getState()
    expect(state.targets.s1.map((t) => t.name)).toEqual(['a.md'])
    expect(state.targets.s2.map((t) => t.name)).toEqual(['b.md'])
  })

  it('keeps the full target list, collectible or not — the artifacts menu needs both', () => {
    const openable = target('notes.txt', { preview: 'text' })
    const unresolved = target('ghost.md', { exists: null })
    panelActions().syncTargets('s1', [openable, unresolved])
    expect(usePanelTabStore.getState().targets.s1).toEqual([openable, unresolved])
  })

  it('opens and closes the panel per session', () => {
    panelActions().setOpen('s1', true)
    expect(usePanelTabStore.getState().open.s1).toBe(true)
    panelActions().setOpen('s1', false)
    expect(usePanelTabStore.getState().open.s1).toBe(false)
  })

  it('does not touch state when setOpen is a no-op', () => {
    panelActions().setOpen('s1', true)
    const before = usePanelTabStore.getState()
    panelActions().setOpen('s1', true)
    expect(usePanelTabStore.getState()).toBe(before)
  })

  it('forgets a session on clearSession', () => {
    panelActions().syncTargets('s1', [target('a.md')])
    panelActions().setOpen('s1', true)
    panelActions().clearSession('s1')
    const state = usePanelTabStore.getState()
    expect(state.targets.s1).toBeUndefined()
    expect(state.open.s1).toBeUndefined()
  })
})

describe('the selectors', () => {
  beforeEach(() => {
    usePanelTabStore.setState({ targets: {}, open: {} })
  })

  it('usePanelTargets returns a stable empty list for an unvisited session', () => {
    const { result, rerender } = renderHook(() => usePanelTargets('none'))
    const first = result.current
    expect(first).toEqual([])
    rerender()
    expect(result.current).toBe(first)
  })

  it('usePanelOpen defaults to closed', () => {
    const { result } = renderHook(() => usePanelOpen('none'))
    expect(result.current).toBe(false)
  })
})
