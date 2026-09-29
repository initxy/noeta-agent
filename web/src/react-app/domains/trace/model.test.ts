import { describe, expect, it } from 'vitest'
import type { RawEnvelope } from '@/app/types'
import {
  categoryOf,
  collectCompactions,
  groupByTurn,
  prefixCacheStatus,
  traceTotals,
  turnStats,
} from './model'

function ev(type: string, seq: number, payload: unknown, taskId = 'task-main'): RawEnvelope {
  return {
    id: `e${seq}`,
    task_id: taskId,
    seq,
    type,
    schema_version: 1,
    occurred_at: 1000 + seq,
    actor: 'engine',
    trace_id: 'tr',
    correlation_id: 'co',
    causation_id: null,
    payload,
    origin: 'engine',
  }
}

describe('collectCompactions — Requested/Compacted paired into one compaction', () => {
  it('adjacent pairing: reason from Requested, replaced_count from Compacted', () => {
    const out = collectCompactions([
      ev('CompactionRequested', 743, { estimated_tokens: 37484, reason: 'proactive' }),
      ev('Compacted', 744, { replaced_count: 103 }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      taskId: 'task-main',
      seq: 743,
      compactedSeq: 744,
      kind: 'proactive',
      estimatedTokens: 37484,
      replacedCount: 103,
    })
  })

  it('an orphan Compacted (no preceding request) is its own card, kind unknown', () => {
    const out = collectCompactions([ev('Compacted', 10, { replaced_count: 5 })])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      seq: 10,
      compactedSeq: 10,
      kind: 'unknown',
      replacedCount: 5,
    })
  })

  it('a request that never lands stays a card with compactedSeq=null', () => {
    const out = collectCompactions([
      ev('CompactionRequested', 7, { estimated_tokens: 100, reason: 'passive' }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ seq: 7, compactedSeq: null, kind: 'passive' })
  })

  it('pairing does not cross task streams: a subagent Compacted does not claim main Requested', () => {
    const out = collectCompactions([
      ev('CompactionRequested', 3, { reason: 'proactive' }, 'task-main'),
      ev('Compacted', 3, { replaced_count: 9 }, 'task-sub'),
      ev('Compacted', 4, { replaced_count: 40 }, 'task-main'),
    ])
    expect(out).toHaveLength(2)
    const main = out.find((c) => c.taskId === 'task-main')
    const sub = out.find((c) => c.taskId === 'task-sub')
    expect(main).toMatchObject({ seq: 3, compactedSeq: 4, replacedCount: 40, kind: 'proactive' })
    expect(sub).toMatchObject({ seq: 3, compactedSeq: 3, kind: 'unknown', replacedCount: 9 })
  })

  it('multiple compactions in one stream pair independently, ordered by time', () => {
    const out = collectCompactions([
      ev('CompactionRequested', 100, { reason: 'proactive' }),
      ev('Compacted', 101, { replaced_count: 50 }),
      ev('CompactionRequested', 300, { reason: 'passive' }),
      ev('Compacted', 301, { replaced_count: 20 }),
    ])
    expect(out.map((c) => [c.seq, c.compactedSeq, c.kind])).toEqual([
      [100, 101, 'proactive'],
      [300, 301, 'passive'],
    ])
  })
})

describe('categoryOf — maps engine types to a colour category', () => {
  it('classifies the known families', () => {
    expect(categoryOf('LLMRequestStarted')).toBe('llm')
    expect(categoryOf('ToolCallStarted')).toBe('tool')
    expect(categoryOf('ToolCallDenied')).toBe('governance')
    expect(categoryOf('Compacted')).toBe('context')
    expect(categoryOf('MessagesAppended')).toBe('message')
  })

  it('an unknown type degrades to lifecycle rather than throwing', () => {
    expect(categoryOf('SomeFutureEnvelope')).toBe('lifecycle')
    expect(categoryOf('TaskStarted')).toBe('lifecycle')
  })
})

describe('groupByTurn — one group per LLM round', () => {
  it('opens a turn at each LLMRequestStarted; pre-round events go to init', () => {
    const groups = groupByTurn([
      ev('TaskStarted', 0, {}),
      ev('LLMRequestStarted', 1, { call_id: 'c1', model: 'm' }),
      ev('LLMRequestFinished', 2, { call_id: 'c1', usage: { output: 5 } }),
      ev('LLMRequestStarted', 3, { call_id: 'c2', model: 'm' }),
    ])
    expect(groups.map((g) => [g.kind, g.label])).toEqual([
      ['init', 'Init'],
      ['turn', 'Turn 1'],
      ['turn', 'Turn 2'],
    ])
    // The round triple is paired by call_id within the group.
    expect(groups[1].round?.finished?.seq).toBe(2)
  })

  it('a session with no LLM events degrades to grouping by TaskStarted/TaskWoken', () => {
    const groups = groupByTurn([ev('TaskStarted', 0, {}), ev('ToolCallStarted', 1, {})])
    expect(groups).toHaveLength(1)
    expect(groups[0].kind).toBe('legacy')
  })
})

describe('turnStats — folds a turn header from its round', () => {
  it('reads model from the request and tokens/cost from the finish', () => {
    const groups = groupByTurn([
      ev('LLMRequestStarted', 1, { call_id: 'c1', model: 'claude' }),
      ev('LLMRequestFinished', 2, {
        call_id: 'c1',
        usage: { uncached: 10, cache_read: 90, output: 7 },
        cost_usd: 0.0123,
      }),
    ])
    const stats = turnStats(groups[0])
    expect(stats).toMatchObject({ model: 'claude', tokensIn: 100, tokensOut: 7, costUsd: 0.0123 })
  })
})

describe('traceTotals — whole-session summary', () => {
  it('counts rounds, tokens, subagents and compactions across the stream', () => {
    const totals = traceTotals([
      ev('LLMRequestStarted', 0, { model: 'claude' }),
      ev('LLMRequestFinished', 1, { usage: { uncached: 5, cache_read: 15, output: 3 } }),
      ev('SubtaskSpawned', 2, { subtask_id: 'sub-a' }),
      ev('CompactionRequested', 3, { reason: 'proactive' }),
      ev('Compacted', 4, { replaced_count: 9 }),
    ])
    expect(totals).toMatchObject({
      model: 'claude',
      rounds: 1,
      tokensIn: 20,
      tokensOut: 3,
      cacheRead: 15,
      subagents: 1,
      summaryCompactions: 1,
    })
    expect(totals.events).toBe(5)
  })
})

describe('prefixCacheStatus — prefix reuse from the last two composes', () => {
  it('unchanged cold prefix hash across the last two composes → stable', () => {
    expect(
      prefixCacheStatus(
        [
          { taskId: 'm', stableHash: 'aaa' },
          { taskId: 'm', stableHash: 'aaa' },
        ],
        'm',
      ),
    ).toBe('stable')
  })

  it('changed cold prefix hash → invalidated', () => {
    expect(
      prefixCacheStatus(
        [
          { taskId: 'm', stableHash: 'aaa' },
          { taskId: 'm', stableHash: 'bbb' },
        ],
        'm',
      ),
    ).toBe('invalidated')
  })

  it('fewer than two hashed composes on the main stream → unknown', () => {
    expect(prefixCacheStatus([{ taskId: 'm', stableHash: 'aaa' }], 'm')).toBe('unknown')
    expect(prefixCacheStatus([], 'm')).toBe('unknown')
  })

  it('empty hashes are skipped, and only the main stream counts', () => {
    // A subagent compose and an empty-hash compose must not be paired with main.
    expect(
      prefixCacheStatus(
        [
          { taskId: 'm', stableHash: 'aaa' },
          { taskId: 'sub', stableHash: 'zzz' },
          { taskId: 'm', stableHash: '' },
        ],
        'm',
      ),
    ).toBe('unknown')
    // With two real main-stream hashes present, the subagent row is ignored.
    expect(
      prefixCacheStatus(
        [
          { taskId: 'm', stableHash: 'aaa' },
          { taskId: 'sub', stableHash: 'zzz' },
          { taskId: 'm', stableHash: 'aaa' },
        ],
        'm',
      ),
    ).toBe('stable')
  })
})
