import { describe, expect, it } from 'vitest'
import {
  AGGREGATE_ROW_CAP,
  aggregateFailures,
  aggregateNowLabel,
  aggregateSummary,
  buildTurns,
  capToolOutput,
  countStepRows,
  describeStep,
  formatDuration,
  itemTimeMs,
  OUTPUT_MAX_LINES,
  parseMcpName,
  stepLineText,
  toolFamily,
} from './aggregate'
import type { TurnRow } from './aggregate'
import { foldEvents, initialConversationState } from './conversation'
import type { ConversationItem, StepItem } from './items'
import type { RawUIEvent } from '../types/ui-events'

/**
 * The projection is pinned against **folded wire frames**, not against
 * hand-built item objects: aggregation is only correct if it agrees with what
 * the fold actually produces, and a fixture that skips the fold cannot tell.
 */

let seq = 0
const frame = (type: string, data: Record<string, unknown>): RawUIEvent => ({
  seq: seq++,
  type,
  data: { _task: 't1', ...data },
})

const said = (content: string) => [frame('user_message', { content })]
const replied = (text: string) => [frame('assistant_text', { text })]

function call(id: string, toolName: string, args: unknown = {}): RawUIEvent[] {
  return [
    frame('tool_call', { call_id: id, tool_name: toolName, arguments: args }),
    frame('tool_result', { call_id: id, success: true, summary: 'ok', output: '' }),
  ]
}

function failing(id: string, toolName: string, args: unknown = {}): RawUIEvent[] {
  return [
    frame('tool_call', { call_id: id, tool_name: toolName, arguments: args }),
    frame('tool_result', { call_id: id, success: false, summary: 'no', output: 'boom' }),
  ]
}

/** A call with no result yet — what an in-flight step looks like. */
const started = (id: string, toolName: string, args: unknown = {}): RawUIEvent[] => [
  frame('tool_call', { call_id: id, tool_name: toolName, arguments: args }),
]

/**
 * Fold a session's worth of frames.
 *
 * Takes a builder rather than an array because `seq` has to be handed out in
 * arrival order: a frame numbered behind the cursor is a duplicate by
 * definition and the fold drops it — silently, which is right on the wire and
 * is exactly what would make a fixture lie.
 */
function items(build: () => RawUIEvent[][]): readonly ConversationItem[] {
  seq = 0
  return foldEvents(initialConversationState(), build().flat()).items
}

function aggregates(rows: readonly TurnRow[]) {
  return rows.filter((row) => row.kind === 'aggregate')
}

const stepOf = (name: string, args: unknown, status: StepItem['status'] = 'success'): StepItem => ({
  kind: 'step',
  key: 1,
  taskId: 't1',
  callId: `c-${name}`,
  toolName: name,
  args,
  status,
  summary: null,
  output: null,
  subtaskId: null,
})

/** Five step rows across three families, with one non-aggregatable row in the middle. */
const workedHard = (): RawUIEvent[][] => [
  call('c1', 'Bash', { command: 'ls' }),
  call('c2', 'Bash', { command: 'pwd' }),
  call('c3', 'Read', { path: '/w/a.ts' }),
  [frame('skill_activated', { skill: 'planner' })],
  call('c4', 'Grep', { pattern: 'todo' }),
  replied('here is the answer'),
]

describe('tool families', () => {
  it('aggregates exactly four families and nothing else', () => {
    expect(toolFamily('Bash')).toBe('command')
    expect(toolFamily('Edit')).toBe('edit')
    expect(toolFamily('Write')).toBe('edit')
    expect(toolFamily('Read')).toBe('read')
    expect(toolFamily('Grep')).toBe('search')
    expect(toolFamily('Glob')).toBe('search')

    // `apply_patch` was removed in 0.6.0 (no reference counterpart); it now
    // has no family and keeps its own row.
    for (const other of ['apply_patch', 'WebFetch', 'WebSearch', 'TodoWrite', 'Task', 'mcp__x__y']) {
      expect(toolFamily(other)).toBeNull()
    }
  })

  it('collapses a run of one family and leaves a fifth tool as its own row', () => {
    const [turn] = buildTurns(
      items(() => [
        said('go'),
        call('c1', 'Bash', { command: 'ls' }),
        call('c2', 'Bash', { command: 'pwd' }),
        call('c3', 'WebFetch', { url: 'https://example.com/docs' }),
        replied('done'),
      ]),
    )

    const groups = aggregates(turn.steps)
    expect(groups).toHaveLength(1)
    expect(groups[0].group.steps.map((step) => step.callId)).toEqual(['c1', 'c2'])
    // The webfetch call keeps a row of its own, after the aggregate line.
    const solo = turn.steps.filter((row) => row.kind === 'item')
    expect(solo).toHaveLength(1)
    expect(solo[0].kind === 'item' && solo[0].item.kind === 'step' && solo[0].item.toolName).toBe(
      'WebFetch',
    )
  })

  it('keeps mixed families in one run and summarises them in a fixed order', () => {
    const [turn] = buildTurns(
      items(() => [
        said('go'),
        call('c1', 'Bash', { command: 'ls' }),
        call('c2', 'Read', { path: '/w/a.ts' }),
        call('c3', 'Edit', { path: '/w/b.ts' }),
        call('c4', 'Grep', { pattern: 'todo' }),
        replied('done'),
      ]),
    )

    const [group] = aggregates(turn.steps)
    expect(group.group.steps).toHaveLength(4)
    expect(aggregateSummary(group.group.steps)).toBe(
      'Edited 1 file, ran 1 command, read 1 file, ran 1 search',
    )
  })

  it('leaves an orphan subtask step inline and lets it break the root run', () => {
    // A child step whose `subtask_started` never arrived in this slice — the
    // live race (child commits before the spawn) and the cross-turn background
    // subagent both produce this. With no anchor to nest under, it stays on the
    // top level exactly as before, and still breaks the two root calls apart.
    const [turn] = buildTurns(
      items(() => [
        said('go'),
        call('c1', 'Bash', { command: 'ls' }),
        [
          frame('tool_call', {
            call_id: 'c2',
            tool_name: 'Bash',
            arguments: { command: 'pwd' },
            subtask_id: 's1',
          }),
        ],
        call('c3', 'Bash', { command: 'whoami' }),
        replied('done'),
      ]),
    )

    // No anchor for 's1', so nothing nests and nothing is dropped: three rows,
    // the orphan between the two root calls keeps them from merging.
    expect(turn.steps.every((row) => row.kind !== 'subtask-group')).toBe(true)
    expect(aggregates(turn.steps)).toHaveLength(0)
    expect(turn.steps).toHaveLength(3)
  })

  it('nests a subtask step under its anchor instead of leaving it inline', () => {
    const [turn] = buildTurns(
      items(() => [
        said('go'),
        call('c1', 'Bash', { command: 'ls' }),
        [frame('subtask_started', { subtask_id: 's1', agent_name: 'explorer', goal: 'look around' })],
        [
          frame('tool_call', {
            call_id: 'c2',
            tool_name: 'Bash',
            arguments: { command: 'pwd' },
            subtask_id: 's1',
          }),
        ],
        call('c3', 'Bash', { command: 'whoami' }),
        [frame('subtask_finished', { subtask_id: 's1', status: 'completed', summary: 'saw it' })],
        replied('done'),
      ]),
    )

    // c2 is pulled out of the top level into the subtask group; it no longer
    // appears as a top-level row. The anchor node itself still breaks the two
    // root calls apart (it is non-aggregatable work between them), so c1 and c3
    // each stay their own row rather than folding another agent's step in.
    const groups = turn.steps.filter((row) => row.kind === 'subtask-group')
    expect(groups).toHaveLength(1)
    const group = groups[0]
    if (group.kind !== 'subtask-group') throw new Error('unreachable')
    expect(group.subtask.subtaskId).toBe('s1')
    // The nested step is c2, and it lives inside the group, not on the top level.
    const nestedC2 = group.children.some(
      (row) => row.kind === 'item' && row.item.kind === 'step' && row.item.callId === 'c2',
    )
    expect(nestedC2).toBe(true)
    const topLevelC2 = turn.steps.some(
      (row) => row.kind === 'item' && row.item.kind === 'step' && row.item.callId === 'c2',
    )
    expect(topLevelC2).toBe(false)
  })

  it('aggregates a subtask’s own consecutive calls inside its group', () => {
    const [turn] = buildTurns(
      items(() => [
        said('go'),
        [frame('subtask_started', { subtask_id: 's1', agent_name: 'explorer', goal: 'read files' })],
        ...(['a', 'b', 'c'] as const).map((n) => [
          frame('tool_call', {
            call_id: `r-${n}`,
            tool_name: 'Read',
            arguments: { path: `/w/${n}.ts` },
            subtask_id: 's1',
          }),
          frame('tool_result', { call_id: `r-${n}`, success: true, summary: 'ok', output: '' }),
        ]),
        [frame('subtask_finished', { subtask_id: 's1', status: 'completed', summary: 'done' })],
        replied('done'),
      ]),
    )

    const [group] = turn.steps.filter((row) => row.kind === 'subtask-group')
    if (group === undefined || group.kind !== 'subtask-group') throw new Error('no group')
    const inner = aggregates(group.children)
    expect(inner).toHaveLength(1)
    expect(aggregateSummary(inner[0].group.steps)).toBe('Read 3 files')
  })

  it('counts a subtask group as its node plus the work nested inside it', () => {
    const [turn] = buildTurns(
      items(() => [
        said('go'),
        [frame('subtask_started', { subtask_id: 's1', agent_name: 'explorer', goal: 'poke' })],
        [
          frame('tool_call', { call_id: 'x1', tool_name: 'Read', arguments: { path: '/w/a.ts' }, subtask_id: 's1' }),
          frame('tool_result', { call_id: 'x1', success: true, summary: 'ok', output: '' }),
        ],
        [
          frame('tool_call', { call_id: 'x2', tool_name: 'Bash', arguments: { command: 'ls' }, subtask_id: 's1' }),
          frame('tool_result', { call_id: 'x2', success: true, summary: 'ok', output: '' }),
        ],
        [frame('subtask_finished', { subtask_id: 's1', status: 'completed', summary: 'done' })],
        replied('done'),
      ]),
    )

    // One group row on the top level, but the count sees the node (1) plus its
    // two nested calls: three units of work.
    expect(turn.steps).toHaveLength(1)
    expect(countStepRows(turn.steps)).toBe(3)
  })

  it('orphans a background subtask’s steps to a later turn when the anchor is elsewhere', () => {
    // The anchor lands in turn 1; the user sends again before the background
    // subagent's step arrives, so the step folds into turn 2's body where no
    // anchor exists. It renders inline rather than vanishing.
    const turns = buildTurns(
      items(() => [
        said('first'),
        [frame('subtask_started', { subtask_id: 's1', agent_name: 'bg', goal: 'run long' })],
        replied('kicked it off'),
        said('second'),
        [
          frame('tool_call', {
            call_id: 'bg1',
            tool_name: 'Read',
            arguments: { path: '/w/late.ts' },
            subtask_id: 's1',
          }),
          frame('tool_result', { call_id: 'bg1', success: true, summary: 'ok', output: '' }),
        ],
        replied('answered'),
      ]),
    )

    expect(turns).toHaveLength(2)
    // Turn 2 has no anchor for 's1', so the step is a plain inline row.
    const secondSteps = turns[1].steps
    expect(secondSteps.every((row) => row.kind !== 'subtask-group')).toBe(true)
    expect(countStepRows(secondSteps)).toBe(1)
  })
})

describe('what breaks a run', () => {
  it('lifts reasoning out of the run and still keys the group on the first call', () => {
    const [turn] = buildTurns(
      items(() => [
        said('go'),
        call('c1', 'Bash', { command: 'ls' }),
        [frame('thinking', { text: 'now check the tests' })],
        call('c2', 'Bash', { command: 'pytest' }),
        [frame('thinking', { text: 'and the types' })],
        call('c3', 'Bash', { command: 'tsc' }),
        replied('green'),
      ]),
    )

    const groups = aggregates(turn.steps)
    expect(groups).toHaveLength(1)
    expect(groups[0].group.steps.map((step) => step.callId)).toEqual(['c1', 'c2', 'c3'])
    // The key is the FIRST call's id: the run grows as calls stream in, and an
    // identity that moved would reset the reader's expansion mid-run.
    expect(groups[0].group.key).toBe('c1')
    // Reasoning no longer sits in the timeline between the calls — it is lifted
    // into the turn's collected `thinking`, in the order it happened, leaving
    // the run of calls unbroken.
    expect(turn.steps.filter((row) => row.kind === 'item')).toHaveLength(0)
    expect(turn.thinking.map((item) => item.text)).toEqual([
      'now check the tests',
      'and the types',
    ])
  })

  it('breaks a run on prose', () => {
    const [turn] = buildTurns(
      items(() => [
        said('go'),
        call('c1', 'Bash', { command: 'ls' }),
        call('c2', 'Bash', { command: 'pwd' }),
        replied('checking the tests next'),
        call('c3', 'Bash', { command: 'pytest' }),
        call('c4', 'Bash', { command: 'tsc' }),
        replied('green'),
      ]),
    )

    const groups = aggregates(turn.steps)
    expect(groups).toHaveLength(2)
    expect(groups[0].group.steps.map((step) => step.callId)).toEqual(['c1', 'c2'])
    expect(groups[1].group.steps.map((step) => step.callId)).toEqual(['c3', 'c4'])
  })

  it('breaks a run on anything that is not a tool call', () => {
    const [turn] = buildTurns(
      items(() => [
        said('go'),
        call('c1', 'Read', { path: '/w/a.ts' }),
        [frame('skill_activated', { skill: 'planner' })],
        call('c2', 'Read', { path: '/w/b.ts' }),
        replied('done'),
      ]),
    )

    expect(aggregates(turn.steps)).toHaveLength(0)
  })
})

describe('the aggregate line', () => {
  it('rolls status up as tense plus a failure count', () => {
    const [turn] = buildTurns(
      items(() => [
        said('go'),
        call('c1', 'Bash', { command: 'ls' }),
        failing('c2', 'Bash', { command: 'nope' }),
        failing('c3', 'Bash', { command: 'also-nope' }),
        replied('done'),
      ]),
    )
    const [group] = aggregates(turn.steps)

    expect(aggregateSummary(group.group.steps)).toBe('Ran 3 commands')
    expect(aggregateFailures(group.group.steps)).toBe(2)
  })

  it('is present-tense with a self-replacing "Now:" line while anything runs', () => {
    const [turn] = buildTurns(
      items(() => [
        said('go'),
        call('c1', 'Bash', { command: 'ls' }),
        started('c2', 'Bash', { command: 'pytest -q' }),
        started('c3', 'Bash', { command: 'npm run typecheck' }),
      ]),
      { running: true },
    )
    const [group] = aggregates(turn.steps)

    expect(aggregateSummary(group.group.steps)).toBe('Running 3 commands')
    // The LATEST in-flight call, not the first, and exactly one line.
    expect(aggregateNowLabel(group.group.steps)).toBe('npm run typecheck')
  })

  it('has no "Now:" line once everything has finished', () => {
    const [turn] = buildTurns(
      items(() => [
        said('go'),
        call('c1', 'Bash', { command: 'ls' }),
        call('c2', 'Bash', { command: 'pwd' }),
      ]),
    )
    const [group] = aggregates(turn.steps)
    expect(aggregateNowLabel(group.group.steps)).toBeNull()
  })

  it('counts unique files for the file families and calls for the rest', () => {
    const steps = [
      stepOf('Edit', { path: '/w/a.ts' }),
      stepOf('Edit', { path: '/w/a.ts' }),
      stepOf('Write', { path: '/w/b.ts' }),
      stepOf('Edit', { path: '/w/c.ts' }),
    ]
    expect(aggregateSummary(steps)).toBe('Edited 3 files')
  })

  it('caps the expanded list at eight rows', () => {
    expect(AGGREGATE_ROW_CAP).toBe(8)
  })
})

describe('sentences, never payloads', () => {
  it('renders an MCP call as a sentence with the service and the query', () => {
    const line = describeStep(
      stepOf('mcp__granola__search_meetings', { query: 'what did we decide about pricing' }),
    )

    expect(line.label).toBe('Searched meetings · Granola')
    expect(line.quote).toBe('what did we decide about pricing')

    const text = stepLineText(stepOf('mcp__granola__search_meetings', { query: 'pricing' }))
    expect(text).toBe('Searched meetings · Granola “pricing”')
    // No braces, no quoted keys — nothing that reads as a payload.
    expect(text).not.toMatch(/[{}]/)
  })

  it('splits an MCP name on the alias boundary', () => {
    expect(parseMcpName('mcp__notion__search_pages')).toEqual({
      alias: 'notion',
      tool: 'search_pages',
    })
    expect(parseMcpName('Bash')).toBeNull()
  })

  it('falls back to a verb phrase for a tool nobody wrote a rule for', () => {
    expect(describeStep(stepOf('mcp__acme__frobnicate_widget', {})).label).toBe(
      'Used frobnicate widget · Acme',
    )
    expect(describeStep(stepOf('custom_thing', {})).label).toBe('Used custom thing')
  })

  it('keeps a path whole for the tooltip and never inlines it raw', () => {
    const line = describeStep(stepOf('Read', { path: '/workspace/src/app/main.ts' }))
    expect(line.label).toBe('Read')
    expect(line.path).toBe('/workspace/src/app/main.ts')
    // The one-string form uses the basename; the full path stays in `path`.
    expect(stepLineText(stepOf('Read', { path: '/workspace/src/app/main.ts' }))).toBe('Read main.ts')
  })

  it('prefers a shell call’s own description over a generic verb', () => {
    const line = describeStep(
      stepOf('Bash', { command: 'git status', description: 'Check the repo' }),
    )
    expect(line.label).toBe('Check the repo')
    expect(line.command).toBe('git status')
  })

  it('switches tense with the call state', () => {
    expect(describeStep(stepOf('Edit', { path: '/w/a.ts' }, 'running')).label).toBe('Editing')
    expect(describeStep(stepOf('Edit', { path: '/w/a.ts' }, 'success')).label).toBe('Edited')
  })
})

describe('the turn fold', () => {
  it('folds a finished turn with more than four step rows', () => {
    const [turn] = buildTurns(items(() => [said('go'), ...workedHard()]))

    expect(turn.stepRowCount).toBe(5)
    expect(turn.folded).toBe(true)
    // The answer is never inside the fold.
    expect(turn.answer).toHaveLength(1)
  })

  it('folds a short finished turn too — every finished turn folds its work', () => {
    const [turn] = buildTurns(
      items(() => [said('go'), call('c1', 'Bash', { command: 'ls' }), replied('done')]),
    )
    expect(turn.folded).toBe(true)
  })

  it('never folds the live turn', () => {
    const [turn] = buildTurns(items(() => [said('go'), ...workedHard()]), { running: true })

    expect(turn.stepRowCount).toBe(5)
    expect(turn.live).toBe(true)
    expect(turn.folded).toBe(false)
  })

  it('counts every call an aggregate absorbed, not the line it renders as', () => {
    const [turn] = buildTurns(
      items(() => [
        said('go'),
        call('c1', 'Bash', { command: 'a' }),
        call('c2', 'Bash', { command: 'b' }),
        call('c3', 'Bash', { command: 'c' }),
        call('c4', 'Bash', { command: 'd' }),
        call('c5', 'Bash', { command: 'e' }),
        replied('done'),
      ]),
    )

    // One rendered row, five calls — and the fold keys off the work.
    expect(turn.steps).toHaveLength(1)
    expect(countStepRows(turn.steps)).toBe(5)
    expect(turn.folded).toBe(true)
  })

  it('labels the fold from server timestamps, and the label survives a reload', () => {
    // The wire carries the clock, so a re-fold of the same frames re-derives
    // the same label. A client-side stopwatch could not: it starts over.
    const clock: Record<number, number> = {}
    for (let key = 0; key <= 40; key += 1) clock[key] = 1_700_000_000_000 + key * 5_000
    const timeOf = (item: ConversationItem) => clock[item.key] ?? null

    const first = buildTurns(items(() => [said('go'), ...workedHard()]), { timeOf })[0]
    // "Reload": a brand-new fold over the very same replayed frames.
    const second = buildTurns(items(() => [said('go'), ...workedHard()]), { timeOf })[0]

    expect(first.label).toMatch(/^Worked for /)
    expect(second.label).toBe(first.label)
  })

  it('falls back to a step count when no clock is on the wire', () => {
    const [turn] = buildTurns(items(() => [said('go'), ...workedHard()]))
    expect(turn.label).toBe('5 steps')
  })

  it('reads the clock the backend actually puts on the wire, through the fold', () => {
    // The default `timeOf` and the real `ts` field, end to end: this is the
    // assertion that fails if the fold stops carrying the frame's clock onto
    // the item, which no `timeOf`-injected test can see.
    let clock = 1_700_000_000
    const stamped = (type: string, data: Record<string, unknown>): RawUIEvent => {
      const event = frame(type, data)
      clock += 19
      return { ...event, data: { ...event.data, ts: clock } }
    }
    const state = foldEvents(initialConversationState(), [
      stamped('user_message', { content: 'go' }),
      stamped('tool_call', { call_id: 'c1', tool_name: 'Read', arguments: { path: 'a.ts' } }),
      stamped('tool_result', { call_id: 'c1', success: true, summary: 'ok', output: '' }),
      stamped('assistant_text', { text: 'done' }),
    ])
    const [turn] = buildTurns(state.items)
    // First work item to last item of the turn: two steps of 19s each.
    expect(turn.label).toBe('Worked for 38s')
  })

  it('reads the optional wire clock as epoch seconds', () => {
    const withTs = { ...stepOf('Read', {}), ts: 1_700_000_000.5 } as unknown as ConversationItem
    expect(itemTimeMs(withTs)).toBe(1_700_000_000_500)
    expect(itemTimeMs(stepOf('Read', {}))).toBeNull()
  })

  it('formats a duration the way the label reads', () => {
    expect(formatDuration(1_400)).toBe('1.4s')
    expect(formatDuration(35_000)).toBe('35s')
    expect(formatDuration(95_000)).toBe('1m 35s')
  })

  it('splits one turn per user message and keeps mid-turn prose inside the work', () => {
    const turns = buildTurns(
      items(() => [
        said('first'),
        replied('one'),
        said('second'),
        call('c1', 'Bash', { command: 'ls' }),
        replied('mid-turn narration'),
        call('c2', 'Bash', { command: 'pwd' }),
        replied('the answer'),
      ]),
    )

    expect(turns).toHaveLength(2)
    expect(turns[1].user?.content).toBe('second')
    // Only the final reply is the answer; the narration folds with the work.
    expect(turns[1].answer).toHaveLength(1)
    expect(countStepRows(turns[1].steps)).toBe(3)
  })

  it('hoists an error out of the fold', () => {
    const [turn] = buildTurns(
      items(() => [
        said('go'),
        call('c1', 'Bash', { command: 'ls' }),
        call('c2', 'Bash', { command: 'pwd' }),
        [frame('error', { message: 'the provider hiccupped' })],
      ]),
    )

    const kinds = turn.answer.map((row) => (row.kind === 'item' ? row.item.kind : 'aggregate'))
    expect(kinds).toContain('error')
  })
})

describe('output caps', () => {
  it('caps shell output by lines and reports what it hid', () => {
    const long = Array.from({ length: OUTPUT_MAX_LINES + 42 }, (_, i) => `line ${i}`).join('\n')
    const capped = capToolOutput(long)

    expect(capped.text.split('\n')).toHaveLength(OUTPUT_MAX_LINES)
    expect(capped.hiddenLines).toBe(42)
  })

  it('caps a single pathological line by characters', () => {
    const capped = capToolOutput('x'.repeat(9_000))
    expect(capped.clipped).toBe(true)
    expect(capped.text.length).toBeLessThan(9_000)
  })

  it('leaves ordinary output alone', () => {
    const capped = capToolOutput('a\nb\nc')
    expect(capped).toEqual({ text: 'a\nb\nc', hiddenLines: 0, clipped: false })
  })
})
