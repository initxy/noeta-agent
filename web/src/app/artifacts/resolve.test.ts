import { describe, expect, it } from 'vitest'
import { deriveArtifactCandidates } from './derive'
import {
  applyResolution,
  artifactChanged,
  degradeUnresolved,
  isCollectibleArtifact,
  isOpenableArtifact,
  resolvablePaths,
  selectAutoOpenArtifact,
  unresolvedTarget,
} from './resolve'
import type { ArtifactCandidate } from '../types/artifacts'
import type { ResolvedArtifact } from '../types/wire'

/**
 * Two-stage trust, pinned from both directions: nothing a client derived is
 * ever collectible on its own, and a server answer is the only thing that can
 * make it so.
 */

const candidate = (over: Partial<ArtifactCandidate> = {}): ArtifactCandidate => ({
  id: 'file:reports/out.md',
  kind: 'file',
  value: 'reports/out.md',
  name: 'out.md',
  preview: 'markdown',
  confidence: 95,
  reason: 'write tool metadata',
  ...over,
})

const resolved = (over: Partial<ResolvedArtifact> = {}): ResolvedArtifact => ({
  path: 'reports/out.md',
  exists: true,
  size: 2048,
  updatedAt: '2026-07-31T10:00:00Z',
  preview: 'markdown',
  ...over,
})

describe('nothing is collectible before the server answers', () => {
  it('leaves a fresh candidate unresolved', () => {
    const target = unresolvedTarget(candidate())
    expect(target.exists).toBeNull()
    expect(isCollectibleArtifact(target)).toBe(false)
    expect(isOpenableArtifact(target)).toBe(false)
  })

  it('leaves a candidate the response did not mention unresolved', () => {
    // Outside the batch cap, or declined by the server: silence is not consent.
    const [target] = applyResolution([candidate()], [resolved({ path: 'other/file.md' })])
    expect(target.exists).toBeNull()
    expect(isCollectibleArtifact(target)).toBe(false)
  })

  it('collects it once the server confirms it', () => {
    const [target] = applyResolution([candidate()], [resolved()])
    expect(target.exists).toBe(true)
    expect(target.size).toBe(2048)
    expect(isCollectibleArtifact(target)).toBe(true)
  })

  it('does not collect a file the server says is missing', () => {
    const [target] = applyResolution(
      [candidate()],
      [resolved({ exists: false, size: null, updatedAt: null })],
    )
    expect(isCollectibleArtifact(target)).toBe(false)
  })

  it('lets the server overwrite the client’s preview guess', () => {
    const [target] = applyResolution([candidate()], [resolved({ preview: 'text' })])
    expect(target.preview).toBe('text')
    // …and a preview the client cannot render is openable but never collected.
    expect(isCollectibleArtifact(target)).toBe(false)
    expect(isOpenableArtifact(target)).toBe(true)
  })

  it('keeps the client’s guess when the server sends a preview this build does not know', () => {
    const [target] = applyResolution([candidate()], [resolved({ preview: 'hologram' })])
    expect(target.preview).toBe('markdown')
  })
})

describe('URLs', () => {
  const link = candidate({
    id: 'url:https://example.com',
    kind: 'url',
    value: 'https://example.com',
    preview: 'browser',
    confidence: 65,
  })

  it('resolve client-side and are never collectible', () => {
    const [target] = applyResolution([link], [])
    expect(target.exists).toBe(true)
    expect(isCollectibleArtifact(target)).toBe(false)
  })

  it('reject a scheme outside the whitelist', () => {
    const [target] = applyResolution(
      [candidate({ id: 'url:javascript:alert(1)', kind: 'url', value: 'javascript:alert(1)' })],
      [],
    )
    expect(target.exists).toBe(false)
  })

  it('are never sent to the server', () => {
    expect(resolvablePaths([link, candidate()])).toEqual(['reports/out.md'])
  })
})

describe('a failed resolve', () => {
  it('keeps URLs and drops every file back to unknown', () => {
    const targets = degradeUnresolved([candidate(), candidate({ id: 'url:https://x.test', kind: 'url', value: 'https://x.test' })])
    expect(targets.filter(isCollectibleArtifact)).toEqual([])
    expect(targets.find((t) => t.kind === 'url')?.exists).toBe(true)
  })
})

describe('the resolve batch', () => {
  it('takes the top of the ladder and stops at the cap', () => {
    const candidates = Array.from({ length: 100 }, (_, i) =>
      candidate({ id: `file:f${i}.md`, value: `f${i}.md`, confidence: 100 - i }),
    )
    const paths = resolvablePaths(candidates)
    expect(paths).toHaveLength(80)
    expect(paths[0]).toBe('f0.md')
    expect(paths.at(-1)).toBe('f79.md')
  })
})

describe('auto-open', () => {
  it('never selects anything — a human always clicks', () => {
    const targets = applyResolution([candidate()], [resolved()])
    expect(targets.every(isCollectibleArtifact)).toBe(true)
    expect(selectAutoOpenArtifact(targets)).toBeNull()
  })
})

describe('freshness', () => {
  it('notices a file rewritten under an open tab', () => {
    const [before] = applyResolution([candidate()], [resolved()])
    const [after] = applyResolution([candidate()], [resolved({ size: 4096, updatedAt: '2026-07-31T11:00:00Z' })])
    expect(artifactChanged(before, after)).toBe(true)
    expect(artifactChanged(before, before)).toBe(false)
  })
})

describe('end to end from a transcript', () => {
  it('turns a write call into exactly one collectible target', () => {
    const candidates = deriveArtifactCandidates([
      {
        kind: 'step',
        key: 1,
        taskId: 't1',
        callId: 'c1',
        toolName: 'write',
        args: { path: 'reports/out.md' },
        status: 'success',
        summary: 'wrote reports/out.md',
        output: null,
        subtaskId: null,
      },
    ])
    expect(resolvablePaths(candidates)).toEqual(['reports/out.md'])

    const beforeServer = candidates.map(unresolvedTarget)
    expect(beforeServer.filter(isCollectibleArtifact)).toEqual([])

    const afterServer = applyResolution(candidates, [resolved()])
    expect(afterServer.filter(isCollectibleArtifact).map((t) => t.name)).toEqual(['out.md'])
  })
})
