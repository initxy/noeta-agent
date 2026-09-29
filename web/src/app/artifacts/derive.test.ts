import { describe, expect, it } from 'vitest'
import { ARTIFACT_RESOLVE_CAP, artifactFingerprint, deriveArtifactCandidates } from './derive'
import { ARTIFACT_CONFIDENCE } from '../types/artifacts'
import type { ConversationItem, StepItem } from '../fold/items'

/**
 * The engine, driven as a table.
 *
 * Every case here is a claim about *provenance*, not about a regex: the same
 * path arriving from two sources must land at two different weights, and the
 * one rule that makes the surface usable — discovery tools contribute nothing —
 * has to hold for the tool's URLs as well as for its paths.
 */

let nextKey = 0
const key = () => nextKey++

const user = (content: string): ConversationItem => ({
  kind: 'user',
  key: key(),
  taskId: 't1',
  content,
  images: [],
  pending: false,
})

const assistant = (text: string): ConversationItem => ({
  kind: 'assistant',
  key: key(),
  taskId: 't1',
  text,
})

const step = (partial: Partial<StepItem> & { toolName: string }): ConversationItem => ({
  kind: 'step',
  key: key(),
  taskId: 't1',
  callId: `call-${key()}`,
  args: {},
  status: 'success',
  summary: null,
  output: null,
  subtaskId: null,
  ...partial,
})

const byId = (items: readonly ConversationItem[], id: string) =>
  deriveArtifactCandidates(items).find((c) => c.id === id)

describe('the provenance ladder', () => {
  it('reads a write tool’s own path argument at 95', () => {
    const found = byId([step({ toolName: 'write', args: { path: 'reports/out.md' } })], 'file:reports/out.md')
    expect(found?.confidence).toBe(ARTIFACT_CONFIDENCE.writeMetadata)
    expect(found?.reason).toBe('write tool metadata')
    expect(found?.preview).toBe('markdown')
  })

  it('reads every file of a multi-file patch from its headers', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: docs/a.md',
      '*** Update File: docs/b.md',
      '*** Move to: docs/c.md',
      '*** End Patch',
    ].join('\n')
    const candidates = deriveArtifactCandidates([
      step({ toolName: 'apply_patch', args: { patchText: patch } }),
    ])
    expect(candidates.map((c) => c.value).sort()).toEqual(['docs/a.md', 'docs/b.md', 'docs/c.md'])
    expect(candidates.every((c) => c.confidence === ARTIFACT_CONFIDENCE.writeMetadata)).toBe(true)
  })

  it('reads a write tool’s prose output at 90, files included', () => {
    const found = byId(
      [step({ toolName: 'write', output: 'wrote reports/summary.md (2.1 KB)' })],
      'file:reports/summary.md',
    )
    expect(found?.confidence).toBe(ARTIFACT_CONFIDENCE.writeOutput)
  })

  it('takes URLs but NOT paths from an ordinary tool at 75', () => {
    const candidates = deriveArtifactCandidates([
      step({
        toolName: 'shell_run',
        output: 'server on http://localhost:5173 serving src/main.tsx',
      }),
    ])
    expect(candidates.map((c) => c.id)).toEqual(['url:http://localhost:5173'])
    expect(candidates[0].confidence).toBe(ARTIFACT_CONFIDENCE.toolPayload)
  })

  it('scans assistant prose for paths only past the artifact-verb gate', () => {
    const gated = deriveArtifactCandidates([assistant('I saved the notes to reports/notes.md')])
    expect(gated.map((c) => c.value)).toEqual(['reports/notes.md'])
    expect(gated[0].confidence).toBe(ARTIFACT_CONFIDENCE.assistantProse)

    const ungated = deriveArtifactCandidates([
      assistant('the entry point is normally src/main.tsx in a Vite app'),
    ])
    expect(ungated).toEqual([])
  })

  it('still takes URLs out of ungated assistant prose', () => {
    const candidates = deriveArtifactCandidates([
      assistant('the docs are at https://example.com/guide'),
    ])
    expect(candidates.map((c) => c.id)).toEqual(['url:https://example.com/guide'])
  })

  it('never takes a path out of user text, and takes its URLs at 40', () => {
    const candidates = deriveArtifactCandidates([
      user('please fix src/broken.ts, see https://example.com/issue/7'),
    ])
    expect(candidates.map((c) => c.id)).toEqual(['url:https://example.com/issue/7'])
    expect(candidates[0].confidence).toBe(ARTIFACT_CONFIDENCE.userText)
  })

  it('takes a subagent’s answer as assistant-grade prose', () => {
    const candidates = deriveArtifactCandidates([
      {
        kind: 'subtask',
        key: key(),
        taskId: 't1',
        subtaskId: 's1',
        agentName: 'writer',
        goal: 'write it',
        status: 'completed',
        summary: 'generated deck/slides.pptx',
      },
    ])
    expect(candidates.map((c) => c.value)).toEqual(['deck/slides.pptx'])
    expect(candidates[0].confidence).toBe(ARTIFACT_CONFIDENCE.assistantProse)
  })
})

describe('discovery tools are excluded wholesale', () => {
  // Paths AND URLs, because the exclusion is not "grep output is noisy" — it is
  // "this tool is reporting what exists, not what was produced", and both halves
  // of a hit are that same claim. A flood written with only paths in it would
  // pass whether or not the exclusion is wired, since the ordinary tool lane
  // takes URLs only; this one fails the moment the exclusion is removed.
  const flood = Array.from(
    { length: 40 },
    (_, i) => `packages/p${i}/package.json: fetch("https://example.com/p${i}")`,
  ).join('\n')

  it.each(['glob', 'grep', 'search', 'find', 'Grep', 'functions.grep'])(
    'contributes nothing from %s',
    (toolName) => {
      expect(deriveArtifactCandidates([step({ toolName, output: flood })])).toEqual([])
    },
  )

  it('floods the panel from the same output when the tool is not a discovery tool', () => {
    // The control case: the exclusion is doing the work, not the lane.
    expect(deriveArtifactCandidates([step({ toolName: 'shell_run', output: flood })])).toHaveLength(
      40,
    )
  })

  it('keeps the same output when a NON-discovery tool reports it', () => {
    const candidates = deriveArtifactCandidates([
      step({ toolName: 'shell_run', output: 'fetch("https://example.com/x")' }),
    ])
    expect(candidates.map((c) => c.id)).toEqual(['url:https://example.com/x'])
  })
})

describe('dedup', () => {
  it('lets a higher-confidence mention replace a lower one', () => {
    const candidates = deriveArtifactCandidates([
      assistant('I wrote reports/out.md'),
      step({ toolName: 'write', args: { path: 'reports/out.md' } }),
    ])
    expect(candidates).toHaveLength(1)
    expect(candidates[0].confidence).toBe(ARTIFACT_CONFIDENCE.writeMetadata)
    expect(candidates[0].reason).toBe('write tool metadata')
  })

  it('does NOT let a lower-confidence mention downgrade a higher one', () => {
    const candidates = deriveArtifactCandidates([
      step({ toolName: 'write', args: { path: 'reports/out.md' } }),
      assistant('I wrote reports/out.md'),
    ])
    expect(candidates).toHaveLength(1)
    expect(candidates[0].confidence).toBe(ARTIFACT_CONFIDENCE.writeMetadata)
  })

  it('lets an equal-confidence mention win, so the latest statement stands', () => {
    const candidates = deriveArtifactCandidates([
      step({ toolName: 'write', args: { path: 'reports/out.md' } }),
      step({ toolName: 'apply_patch', args: { patchText: '*** Update File: reports/out.md' } }),
    ])
    expect(candidates).toHaveLength(1)
    expect(candidates[0].reason).toBe('patch metadata')
  })

  it('folds one path mentioned in two casings into one candidate', () => {
    const candidates = deriveArtifactCandidates([
      step({ toolName: 'write', args: { path: 'Reports/Out.md' } }),
      step({ toolName: 'write', args: { path: 'reports/out.md' } }),
    ])
    expect(candidates).toHaveLength(1)
  })

  it('sorts by confidence and keeps first-mention order within a rung', () => {
    const candidates = deriveArtifactCandidates([
      assistant('I saved notes/a.md and notes/b.md'),
      step({ toolName: 'write', args: { path: 'notes/c.md' } }),
    ])
    expect(candidates.map((c) => c.value)).toEqual(['notes/c.md', 'notes/a.md', 'notes/b.md'])
  })
})

describe('paths', () => {
  it('makes an absolute path under the project root workspace-relative', () => {
    const candidates = deriveArtifactCandidates(
      [step({ toolName: 'write', args: { path: '/home/me/proj/reports/out.md' } })],
      { workspaceRoot: '/home/me/proj' },
    )
    expect(candidates.map((c) => c.value)).toEqual(['reports/out.md'])
  })

  it('drops an absolute path OUTSIDE the project root', () => {
    // The server would reject it, and a permanently-missing entry teaches the
    // user that the panel lies.
    expect(
      deriveArtifactCandidates([step({ toolName: 'write', args: { path: '/etc/passwd.bak' } })], {
        workspaceRoot: '/home/me/proj',
      }),
    ).toEqual([])
  })

  it('strips a container workspace prefix', () => {
    const candidates = deriveArtifactCandidates([
      step({ toolName: 'write', args: { path: 'workspaces/abc123/reports/out.md' } }),
    ])
    expect(candidates.map((c) => c.value)).toEqual(['reports/out.md'])
  })

  it('rejects a traversal, an extensionless name, and an over-long match', () => {
    const items = [
      step({ toolName: 'write', args: { path: '../outside.md' } }),
      step({ toolName: 'write', args: { path: 'Makefile' } }),
      step({ toolName: 'write', args: { path: `${'a'.repeat(600)}.md` } }),
    ]
    expect(deriveArtifactCandidates(items)).toEqual([])
  })

  it('yields one candidate for a markdown link whose label is its basename', () => {
    const candidates = deriveArtifactCandidates([
      assistant('I created [out.md](reports/out.md)'),
    ])
    expect(candidates.map((c) => c.value)).toEqual(['reports/out.md'])
  })

  it('yields two when the label names something else', () => {
    const candidates = deriveArtifactCandidates([
      assistant('I created [summary.md](reports/out.md)'),
    ])
    expect(candidates.map((c) => c.value).sort()).toEqual(['reports/out.md', 'summary.md'])
  })

  it('folds the trailing slashes of one origin into a single URL candidate', () => {
    const candidates = deriveArtifactCandidates([
      step({ toolName: 'shell_run', output: 'up on http://localhost:3000/ and http://localhost:3000//' }),
    ])
    expect(candidates.map((c) => c.id)).toEqual(['url:http://localhost:3000'])
  })
})

describe('what is deliberately not scanned', () => {
  it('ignores thinking and recall', () => {
    const items: ConversationItem[] = [
      { kind: 'thinking', key: key(), taskId: 't1', text: 'maybe I will write reports/draft.md' },
      { kind: 'recall', key: key(), taskId: 't1', text: 'last time I wrote reports/old.md' },
    ]
    expect(deriveArtifactCandidates(items)).toEqual([])
  })

  it('ignores the file a read tool names', () => {
    expect(
      deriveArtifactCandidates([step({ toolName: 'read', args: { path: 'src/main.tsx' } })]),
    ).toEqual([])
  })
})

describe('fingerprint', () => {
  it('changes when a candidate is added and not when the transcript merely grows', () => {
    const written = [step({ toolName: 'write', args: { path: 'a.md' } })]
    const before = artifactFingerprint(deriveArtifactCandidates(written))
    const after = artifactFingerprint(
      deriveArtifactCandidates([...written, assistant('done, no new files')]),
    )
    expect(after).toBe(before)

    const grown = artifactFingerprint(
      deriveArtifactCandidates([...written, step({ toolName: 'write', args: { path: 'b.md' } })]),
    )
    expect(grown).not.toBe(before)
  })
})

describe('the resolve cap', () => {
  it('is 80', () => {
    expect(ARTIFACT_RESOLVE_CAP).toBe(80)
  })
})
