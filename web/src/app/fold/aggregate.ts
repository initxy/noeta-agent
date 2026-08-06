/**
 * Turn blocks and tool aggregation — the pass that makes a transcript readable.
 *
 * The fold (`conversation.ts`) produces a flat, chronological item list: that
 * is the record of what happened and it stays flat, because every rule about
 * replay, dedup and branches is stated over it. This module is a **pure
 * projection** of that list into what a person reads:
 *
 * 1. **A conversation is turn-centric, not message-centric.** One user message
 *    and everything the agent did until it parked is one block, and the block
 *    — not the message — owns the fold over the work, the outcome notice, and
 *    (Phase 5) the files strip and the action bar.
 * 2. **Consecutive calls of four families collapse into one line.** Bash /
 *    Edit+Write / Read / Grep+Glob. Nothing else: a subagent, a
 *    skill, a checklist or an MCP call is always its own row, because each of
 *    those is a decision the reader wants to see, while "ran eight commands" is
 *    one fact.
 * 3. **Reasoning does not break a run; prose and files do.** Thinking models
 *    emit a reasoning block before nearly every call, and letting that split
 *    the run degrades every aggregate back to single rows — which is the whole
 *    feature, gone. Prose is the agent changing subject, so it does break.
 *
 * Being pure and framework-free is what makes all of that testable without
 * mounting anything, and it is why the renderers under
 * `react-app/domains/session/conversation/` hold no aggregation logic at all —
 * they render the rows this module hands them.
 */

import type { ConversationItem, StepItem, SubtaskItem, ThinkingItem, UserItem } from './items'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Rows shown inside an expanded aggregate before "Show N more". */
export const AGGREGATE_ROW_CAP = 8

/**
 * Calls a run needs before it collapses into a summary line.
 *
 * The interaction reference aggregates from one call, so a single command
 * reads as "Ran 1 command" behind a chevron. One call is not a summary — it is
 * the same row with its detail hidden — so a lone call stays an ordinary tool
 * row and keeps whatever per-tool rendering it has.
 */
export const AGGREGATE_MIN_RUN = 2

/**
 * A finished turn folds its work into one line, whatever its size.
 *
 * The transcript is read for its answers; the work behind each turn is
 * available rather than imposed. Only the *live* turn stays expanded — watching
 * work happen is the reason to keep the window open — and it collapses once it
 * parks. A single-call turn folds too: "Ran a command" behind a chevron is one
 * calm line instead of a stray row breaking the rhythm between two answers.
 */
export const TURN_FOLDS_WHEN_FINISHED = true

/** Lines of tool output rendered before the rest is summarised away. */
export const OUTPUT_MAX_LINES = 120

/**
 * Characters of tool output rendered.
 *
 * The wire already clips `output` at 2000 characters, so this is the second
 * guard rather than the first: it bounds a pathological single line, which the
 * line cap alone does not. Shell output is the case the reference left
 * completely uncapped — an unbounded, unscrolled `<pre>` — and it is the one
 * tool whose output routinely runs to thousands of lines.
 */
export const OUTPUT_MAX_CHARS = 4000

/** Characters of a shell command shown on a one-line row. */
const COMMAND_PREVIEW_CHARS = 96

/** Characters of a quoted query or pattern shown inline. */
const QUERY_PREVIEW_CHARS = 80

// ---------------------------------------------------------------------------
// Tool families
// ---------------------------------------------------------------------------

/** The four families that aggregate. Everything else renders as its own row. */
export type ToolFamily = 'command' | 'edit' | 'read' | 'search'

/**
 * The name → family table.
 *
 * Spelled with this runtime's tool names — the Claude Code reference surface
 * (`Bash`, `Read`, `Edit`, `Write`, `Grep`, `Glob`). An unknown name has no
 * family and therefore never aggregates, which is the safe default: a tool
 * nobody wrote a rule for keeps its own row rather than disappearing into a
 * count.
 */
const TOOL_FAMILIES: Readonly<Record<string, ToolFamily>> = {
  Bash: 'command',
  Edit: 'edit',
  Write: 'edit',
  Read: 'read',
  Grep: 'search',
  Glob: 'search',
}

export function toolFamily(toolName: string): ToolFamily | null {
  return TOOL_FAMILIES[toolName] ?? null
}

/**
 * Whether a step may join an aggregate run on the **top level**.
 *
 * A subtask's steps are excluded here: `buildGroupedRows` pulls the ones with a
 * matching anchor into their own child list, and an *orphan* subtask step (a
 * live child that arrived before its `subtask_started`, or a background
 * subagent's step folded into a later turn) is left inline but must not merge
 * into the root's run — folding it into the root's count would attribute
 * another agent's work to this one. Inside a subtask node the rule is
 * `isAggregatableStep`, which has no such exclusion.
 */
function isAggregatable(item: ConversationItem): item is StepItem {
  return item.kind === 'step' && item.subtaskId === null && toolFamily(item.toolName) !== null
}

/**
 * Whether a step may join an aggregate run **inside a subtask node**.
 *
 * Every step in a subtask's bucket already belongs to that one agent, so the
 * root-exclusion `isAggregatable` applies no longer matters — the same
 * "eight reads is one line" rule runs over the subagent's own calls.
 */
function isAggregatableStep(item: ConversationItem): item is StepItem {
  return item.kind === 'step' && toolFamily(item.toolName) !== null
}

// ---------------------------------------------------------------------------
// Reading a call's arguments
// ---------------------------------------------------------------------------

function argsOf(step: StepItem): Record<string, unknown> {
  const { args } = step
  return typeof args === 'object' && args !== null && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {}
}

function stringArg(args: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return null
}

/**
 * Every workspace path a call names.
 *
 * A single call may carry a list of edits rather than one path (the `edits`
 * array shape), so it can touch several files — which is exactly why the
 * aggregate counts *unique paths* and not calls for the file families.
 */
export function stepPaths(step: StepItem): string[] {
  const args = argsOf(step)
  const edits = args.edits
  if (Array.isArray(edits)) {
    const paths: string[] = []
    for (const edit of edits) {
      if (typeof edit !== 'object' || edit === null) continue
      const path = stringArg(edit as Record<string, unknown>, 'path', 'file_path', 'filePath')
      if (path !== null) paths.push(path)
    }
    if (paths.length > 0) return [...new Set(paths)]
  }
  const path = stringArg(args, 'path', 'file_path', 'filePath', 'filename', 'file')
  return path === null ? [] : [path]
}

/** The last segment of a path — what a chip shows instead of the raw path. */
export function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  const name = cut === -1 ? trimmed : trimmed.slice(cut + 1)
  return name === '' ? path : name
}

// ---------------------------------------------------------------------------
// Sentences — a tool call is never rendered as JSON
// ---------------------------------------------------------------------------

export type Tense = 'present' | 'past'

/**
 * One tool call as a sentence plus its typed parts.
 *
 * The parts are separate fields rather than pre-joined text because each is
 * rendered differently and none of them is ever a raw payload: a path becomes a
 * chip carrying its basename and a full-path tooltip, a command becomes
 * monospace, a query becomes a quotation. `stepLineText` joins them for the
 * places that need one string (the "Now:" line, a `title`, a test).
 */
export interface StepLine {
  /** The sentence: "Edited", "Ran a command", "Searching meetings · Granola". */
  label: string
  /** A workspace path the call named, full. Render as a chip, never raw. */
  path: string | null
  /** A shell command. Render monospace, truncated. */
  command: string | null
  /** A query, pattern or URL. Render quoted. */
  quote: string | null
}

const VERBS: Readonly<Record<string, readonly [string, string]>> = {
  ask: ['Asking', 'Asked'],
  search: ['Searching', 'Searched'],
  find: ['Finding', 'Found'],
  get: ['Fetching', 'Fetched'],
  fetch: ['Fetching', 'Fetched'],
  list: ['Listing', 'Listed'],
  read: ['Reading', 'Read'],
  check: ['Checking', 'Checked'],
  create: ['Creating', 'Created'],
  add: ['Adding', 'Added'],
  send: ['Sending', 'Sent'],
  update: ['Updating', 'Updated'],
  delete: ['Deleting', 'Deleted'],
  remove: ['Removing', 'Removed'],
  execute: ['Running', 'Ran'],
  run: ['Running', 'Ran'],
  open: ['Opening', 'Opened'],
  query: ['Querying', 'Queried'],
  write: ['Writing', 'Wrote'],
}

function pick(pair: readonly [string, string], tense: Tense): string {
  return tense === 'present' ? pair[0] : pair[1]
}

/** Split an identifier into words: `search_meetings`, `searchMeetings`, `search-meetings`. */
function words(name: string): string[] {
  return name
    .split(/[_\-.\s]+|(?<=[a-z0-9])(?=[A-Z])/)
    .map((word) => word.trim().toLowerCase())
    .filter((word) => word !== '')
}

/**
 * A tool name as a verb phrase: `search_meetings` → "Searching meetings".
 *
 * The leading word is looked up in the verb table and the rest is kept as the
 * object. An unmapped leading word falls back to "Using"/"Used" over the whole
 * name, so an unknown tool still reads as a sentence rather than as an
 * identifier.
 */
export function verbPhrase(name: string, tense: Tense): string {
  const parts = words(name)
  if (parts.length === 0) return pick(['Using', 'Used'], tense)
  const [head, ...rest] = parts
  const known = VERBS[head]
  if (known === undefined) return [pick(['Using', 'Used'], tense), ...parts].join(' ')
  return [pick(known, tense), ...rest].join(' ')
}

function titleCase(value: string): string {
  return words(value)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** The MCP alias and tool inside `mcp__<alias>__<tool>`, or null. */
export function parseMcpName(toolName: string): { alias: string; tool: string } | null {
  if (!toolName.startsWith('mcp__')) return null
  const rest = toolName.slice('mcp__'.length)
  const cut = rest.indexOf('__')
  if (cut === -1) return rest === '' ? null : { alias: rest, tool: '' }
  return { alias: rest.slice(0, cut), tool: rest.slice(cut + 2) }
}

/** The query a call is "about", from whichever key the tool happened to use. */
function queryOf(args: Record<string, unknown>): string | null {
  const direct = stringArg(args, 'query', 'q', 'search', 'prompt', 'question', 'message', 'text')
  if (direct !== null) return direct
  const body = args.body
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    return stringArg(body as Record<string, unknown>, 'query', 'q', 'search', 'prompt', 'question', 'message', 'text')
  }
  return null
}

function hostOf(url: string): string | null {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#\s]+)/i.exec(url)
  return match ? match[1] : null
}

function defaultTense(step: StepItem): Tense {
  return step.status === 'running' ? 'present' : 'past'
}

/**
 * One call, as a sentence.
 *
 * Two rules run through every branch. **Never render raw JSON**: an argument
 * object is a payload, and a payload belongs under "Technical details" where
 * someone who wants it can ask. **Never render a raw path**: a chip carrying
 * the basename says which file, and the tooltip says where — an absolute path
 * inside a container says neither, at four times the width.
 */
export function describeStep(step: StepItem, tense: Tense = defaultTense(step)): StepLine {
  const args = argsOf(step)
  const paths = stepPaths(step)
  const path = paths.length === 1 ? paths[0] : null

  const mcp = parseMcpName(step.toolName)
  if (mcp !== null) {
    // An MCP call is an ordinary tool named `mcp__<alias>__<tool>`, so keying
    // on the prefix is the whole of the detection: the connector alias is the
    // service, the trailing name is the verb phrase.
    const phrase = mcp.tool === '' ? verbPhrase(mcp.alias, tense) : verbPhrase(mcp.tool, tense)
    const service = titleCase(mcp.alias)
    const query = queryOf(args)
    return {
      label: service === '' ? phrase : `${phrase} · ${service}`,
      path: null,
      command: null,
      quote: query === null ? null : clip(query, QUERY_PREVIEW_CHARS),
    }
  }

  switch (step.toolName) {
    case 'Bash': {
      const command = stringArg(args, 'command')
      const description = stringArg(args, 'description')
      return {
        label: description ?? pick(['Running a command', 'Ran a command'], tense),
        path: null,
        command,
        quote: null,
      }
    }
    case 'BashOutput':
      return { label: pick(['Checking a background job', 'Checked a background job'], tense), path: null, command: null, quote: null }
    case 'KillShell':
      return { label: pick(['Stopping a background job', 'Stopped a background job'], tense), path: null, command: null, quote: null }
    case 'Read':
      return { label: pick(['Reading', 'Read'], tense), path, command: null, quote: null }
    case 'Write':
      return { label: pick(['Writing', 'Wrote'], tense), path, command: null, quote: null }
    case 'Edit':
      return { label: pick(['Editing', 'Edited'], tense), path, command: null, quote: null }
    case 'Grep': {
      const pattern = stringArg(args, 'pattern')
      return {
        label: pick(['Searching for', 'Searched for'], tense),
        path,
        command: null,
        quote: pattern === null ? null : clip(pattern, QUERY_PREVIEW_CHARS),
      }
    }
    case 'Glob': {
      const pattern = stringArg(args, 'pattern')
      return {
        label: pick(['Matching files', 'Matched files'], tense),
        path,
        command: null,
        quote: pattern === null ? null : clip(pattern, QUERY_PREVIEW_CHARS),
      }
    }
    case 'WebFetch': {
      const url = stringArg(args, 'url')
      const host = url === null ? null : hostOf(url)
      return {
        label: pick(['Reading', 'Read'], tense),
        path: null,
        command: null,
        quote: host ?? (url === null ? null : clip(url, QUERY_PREVIEW_CHARS)),
      }
    }
    case 'WebSearch': {
      const query = queryOf(args)
      return {
        label: pick(['Searching the web for', 'Searched the web for'], tense),
        path: null,
        command: null,
        quote: query === null ? null : clip(query, QUERY_PREVIEW_CHARS),
      }
    }
    case 'TodoWrite':
      return { label: pick(['Updating the plan', 'Updated the plan'], tense), path: null, command: null, quote: null }
    case 'AskUserQuestion':
      return { label: pick(['Asking a question', 'Asked a question'], tense), path: null, command: null, quote: null }
    case 'Task': {
      const goal = stringArg(args, 'prompt', 'description', 'goal')
      return {
        label: pick(['Delegating', 'Delegated'], tense),
        path: null,
        command: null,
        quote: goal === null ? null : clip(goal, QUERY_PREVIEW_CHARS),
      }
    }
    default: {
      const query = queryOf(args)
      return {
        label: verbPhrase(step.toolName, tense),
        path,
        command: null,
        quote: query === null ? null : clip(query, QUERY_PREVIEW_CHARS),
      }
    }
  }
}

/**
 * The same sentence as one string.
 *
 * For the places that cannot render parts: the self-replacing "Now:" line, a
 * `title` attribute, an aria-label.
 */
export function stepLineText(step: StepItem, tense: Tense = defaultTense(step)): string {
  const line = describeStep(step, tense)
  const parts: string[] = [line.label]
  if (line.command !== null) parts.push(clip(line.command, COMMAND_PREVIEW_CHARS))
  if (line.path !== null) parts.push(basename(line.path))
  if (line.quote !== null) parts.push(`“${line.quote}”`)
  return parts.join(' ')
}

// ---------------------------------------------------------------------------
// Aggregate groups
// ---------------------------------------------------------------------------

/**
 * A run of consecutive aggregatable calls, rendered as one line.
 *
 * The key is the **first call's id**: the group grows as more calls stream in,
 * and keying on anything derived from the whole run (a count, a hash of the
 * members) would change identity on every arrival and reset the reader's
 * expansion mid-run.
 */
export interface AggregateGroup {
  key: string
  steps: readonly StepItem[]
}

export function aggregateTense(steps: readonly StepItem[]): Tense {
  return steps.some((step) => step.status === 'running') ? 'present' : 'past'
}

export function aggregateFailures(steps: readonly StepItem[]): number {
  return steps.filter((step) => step.status === 'failure').length
}

function countFiles(steps: readonly StepItem[]): number {
  const paths = new Set<string>()
  let unnamed = 0
  for (const step of steps) {
    const own = stepPaths(step)
    if (own.length === 0) unnamed += 1
    for (const path of own) paths.add(path)
  }
  return paths.size + unnamed
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many
}

/**
 * "Edited 3 files, ran 8 commands, read 2 files, ran 4 searches".
 *
 * Clause order is fixed (edit, command, read, search) rather than
 * first-seen: the line is read at a glance across many turns, and a stable
 * shape is what makes that possible. Tense is present while anything in the run
 * is still running.
 */
export function aggregateSummary(steps: readonly StepItem[], tense = aggregateTense(steps)): string {
  const byFamily = new Map<ToolFamily, StepItem[]>()
  for (const step of steps) {
    const family = toolFamily(step.toolName)
    if (family === null) continue
    const bucket = byFamily.get(family)
    if (bucket === undefined) byFamily.set(family, [step])
    else bucket.push(step)
  }

  const clauses: string[] = []
  const edits = byFamily.get('edit')
  if (edits !== undefined) {
    const n = countFiles(edits)
    clauses.push(`${pick(['editing', 'edited'], tense)} ${n} ${plural(n, 'file', 'files')}`)
  }
  const commands = byFamily.get('command')
  if (commands !== undefined) {
    const n = commands.length
    clauses.push(`${pick(['running', 'ran'], tense)} ${n} ${plural(n, 'command', 'commands')}`)
  }
  const reads = byFamily.get('read')
  if (reads !== undefined) {
    const n = countFiles(reads)
    clauses.push(`${pick(['reading', 'read'], tense)} ${n} ${plural(n, 'file', 'files')}`)
  }
  const searches = byFamily.get('search')
  if (searches !== undefined) {
    const n = searches.length
    clauses.push(`${pick(['running', 'ran'], tense)} ${n} ${plural(n, 'search', 'searches')}`)
  }

  const joined = clauses.join(', ')
  return joined === '' ? '' : joined.charAt(0).toUpperCase() + joined.slice(1)
}

/**
 * The one call the summary line is currently doing.
 *
 * Deliberately **one** line that replaces itself, never a list: the point of
 * the aggregate is that the run is one fact, and a growing list of in-flight
 * rows is the thing it exists to prevent. The latest in-flight call wins, so
 * the line tracks the work instead of the order it was queued in.
 */
export function aggregateNowLabel(steps: readonly StepItem[]): string | null {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index]
    if (step.status !== 'running') continue
    if (step.toolName === 'Bash') {
      const command = stringArg(argsOf(step), 'command')
      if (command !== null) return clip(command, COMMAND_PREVIEW_CHARS)
    }
    return stepLineText(step, 'present')
  }
  return null
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type TurnRow =
  | { kind: 'item'; key: string; item: ConversationItem }
  | { kind: 'aggregate'; key: string; group: AggregateGroup }
  | { kind: 'subtask-group'; key: string; subtask: SubtaskItem; children: TurnRow[] }

/**
 * A render key that is unique across streams.
 *
 * An item's own key is a `seq`, which is only unique **within** its task
 * stream — and a branch view renders items from an ancestor stream next to the
 * branch's own, where both count from 0.
 */
function rowKey(item: ConversationItem): string {
  return `${item.taskId ?? ''}:${item.key}`
}

interface OpenRun {
  steps: StepItem[]
}

function buildRows(
  items: readonly ConversationItem[],
  aggregatable: (item: ConversationItem) => item is StepItem = isAggregatable,
): TurnRow[] {
  const draft: Array<ConversationItem | OpenRun> = []
  let run: OpenRun | null = null

  for (const item of items) {
    if (aggregatable(item)) {
      if (run !== null) {
        run.steps.push(item)
        continue
      }
      run = { steps: [item] }
      draft.push(run)
      continue
    }
    run = null
    draft.push(item)
  }

  return draft.map((entry) => {
    if (!('steps' in entry)) return { kind: 'item', key: rowKey(entry), item: entry }
    if (entry.steps.length < AGGREGATE_MIN_RUN) {
      const only = entry.steps[0]
      return { kind: 'item', key: rowKey(only), item: only }
    }
    const first = entry.steps[0]
    return {
      kind: 'aggregate',
      key: `agg:${first.taskId ?? ''}:${first.callId}`,
      group: { key: first.callId, steps: entry.steps },
    }
  })
}

/**
 * Rows with each subtask's steps nested under its node.
 *
 * The fold interleaves a subagent's steps with the root's by arrival, not by
 * causality (they come off separate streams), so a flat pass renders them as
 * siblings and the reader cannot tell whose work is whose. This pulls every
 * step carrying a `subtaskId` that matches an anchor in this slice into that
 * anchor's own child list, then aggregates each list independently — the root
 * on the top level, each subagent inside its node.
 *
 * A step whose `subtaskId` has no anchor here stays on the top level and
 * renders inline. That is not a corner case to tolerate but the correct
 * behaviour for two real ones: a live child step can arrive before its
 * `subtask_started`, and a background subagent's steps can land in a later
 * turn than the anchor. Nothing is ever hidden for lack of a parent.
 */
function buildGroupedRows(items: readonly ConversationItem[]): TurnRow[] {
  const anchors = new Set<string>()
  for (const item of items) {
    if (item.kind === 'subtask') anchors.add(item.subtaskId)
  }

  const buckets = new Map<string, StepItem[]>()
  const topLevel: ConversationItem[] = []
  for (const item of items) {
    if (item.kind === 'step' && item.subtaskId !== null && anchors.has(item.subtaskId)) {
      const bucket = buckets.get(item.subtaskId)
      if (bucket === undefined) buckets.set(item.subtaskId, [item])
      else bucket.push(item)
    } else {
      topLevel.push(item)
    }
  }

  return buildRows(topLevel).map((row) => {
    if (row.kind === 'item' && row.item.kind === 'subtask') {
      const subtask = row.item
      return {
        kind: 'subtask-group',
        key: rowKey(subtask),
        subtask,
        children: buildRows(buckets.get(subtask.subtaskId) ?? [], isAggregatableStep),
      }
    }
    return row
  })
}

/**
 * How much work a row stands for.
 *
 * An aggregate counts every call it absorbed rather than one: it reads as a
 * single line, but the fold keys off work done, and eight commands behind one
 * line is still eight commands. A subtask group counts its node plus the work
 * nested inside it, for the same reason.
 */
export function countStepRows(rows: readonly TurnRow[]): number {
  return rows.reduce((total, row) => {
    if (row.kind === 'aggregate') return total + row.group.steps.length
    if (row.kind === 'subtask-group') return total + 1 + countStepRows(row.children)
    return total + 1
  }, 0)
}

// ---------------------------------------------------------------------------
// Turn blocks
// ---------------------------------------------------------------------------

export interface TurnBlock {
  /** Stable across re-folds: the opening message's identity, or the block's first row. */
  key: string
  /** The message that opened the turn. Null for anything before the first one. */
  user: UserItem | null
  /**
   * The turn's reasoning, in order, lifted out of the step stream.
   *
   * A thinking model emits one of these before nearly every call, so left in
   * the timeline they interleave with the steps as a stutter of "Thought"
   * disclosures. Collected here, the renderer folds them into one line ("思考 ·
   * N 段") the reader opens on purpose. They are still work — collapsed with the
   * process, never in the answer.
   */
  thinking: readonly ThinkingItem[]
  /** The work, in order. Hidden behind the fold when `folded`. */
  steps: readonly TurnRow[]
  /** The answer, and anything that must never be folded away. */
  answer: readonly TurnRow[]
  /** Work rows, counting each call an aggregate absorbed. */
  stepRowCount: number
  /** This block is the turn in flight. A live turn never folds. */
  live: boolean
  /** The work starts collapsed. */
  folded: boolean
  /** What the fold says: "Worked for 1m 35s", else "6 steps". */
  label: string
}

export interface TurnOptions {
  /** A turn is in flight, which makes the last block live. */
  running?: boolean
  /**
   * An item's server clock, in epoch milliseconds, or null when it has none.
   *
   * Injected so the duration is testable without a wire, and defaulted to
   * `itemTimeMs` — which reads the frame's optional `ts`. It has to be the
   * *server's* clock: a duration measured in the browser is recomputed from
   * scratch on every reload, so a reloaded conversation would either show a
   * wrong number or lose the label the fold is named after.
   */
  timeOf?: (item: ConversationItem) => number | null
}

/**
 * The server clock an item was derived from, in epoch milliseconds.
 *
 * The wire carries it as the optional `ts` on a durable frame's `data` (epoch
 * seconds, the source envelope's `occurred_at`) and the fold copies it onto the
 * item. It stays **optional** all the way down: a synthetic frame has no clock,
 * and a turn built only from synthetic items falls back to a step count.
 * Absence is a documented state here, never a bug.
 */
export function itemTimeMs(item: ConversationItem): number | null {
  const { ts } = item
  return typeof ts === 'number' && Number.isFinite(ts) ? ts * 1000 : null
}

/** `1.4s` / `35s` / `1m 35s`. */
export function formatDuration(ms: number): string {
  const seconds = ms / 1000
  if (seconds < 10) return `${Math.max(0.1, seconds).toFixed(1)}s`
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${Math.round(seconds % 60)}s`
}

/** Items that are the agent working, as opposed to the agent answering. */
function isWork(item: ConversationItem): boolean {
  switch (item.kind) {
    case 'step':
    case 'memory':
    case 'skill':
    case 'todos':
    case 'subtask':
    case 'thinking':
    case 'recall':
      return true
    default:
      return false
  }
}

/**
 * Things that happened *to* the conversation. They are never folded away.
 *
 * An error especially: the fold's whole promise is that what it hides is
 * routine, and a turn that failed is not routine. Hoisting the notice out of
 * the fold costs a row and buys the guarantee.
 */
function isNotice(item: ConversationItem): boolean {
  switch (item.kind) {
    case 'error':
    case 'question':
    case 'compaction':
      return true
    default:
      return false
  }
}

/**
 * Where the answer starts inside one turn.
 *
 * The answer is the trailing run of non-work items — so mid-turn narration
 * ("checking the config next") belongs to the work and folds with it, while the
 * final reply stays visible. A notice anywhere earlier pulls the boundary back
 * to itself, because nothing after a notice may be hidden.
 */
function answerStart(body: readonly ConversationItem[]): number {
  let start = body.length
  while (start > 0 && !isWork(body[start - 1])) start -= 1
  const notice = body.findIndex(isNotice)
  if (notice !== -1 && notice < start) return notice
  return start
}

/**
 * The transcript as turn blocks.
 *
 * Pure: same items in, same blocks out, no clock read and no state kept. The
 * caller passes `running` because whether the last turn is live is a fact about
 * the session, not about the list.
 */
export function buildTurns(
  items: readonly ConversationItem[],
  options: TurnOptions = {},
): TurnBlock[] {
  const timeOf = options.timeOf ?? itemTimeMs
  const running = options.running ?? false

  const groups: ConversationItem[][] = []
  for (const item of items) {
    if (item.kind === 'user' || groups.length === 0) groups.push([])
    groups[groups.length - 1].push(item)
  }

  return groups.map((group, index) => {
    const user = group[0].kind === 'user' ? group[0] : null
    const body = user === null ? group : group.slice(1)
    const cut = answerStart(body)

    const stepItems = body.slice(0, cut)
    // Reasoning is lifted out of the timeline into its own collected line; the
    // remaining work items keep their order and their aggregation. `answerStart`
    // already guarantees no thinking sits in the answer (it is work, so it is
    // never in the trailing non-work run), so filtering the step slice is enough.
    const thinking = stepItems.filter((item): item is ThinkingItem => item.kind === 'thinking')
    const steps = buildGroupedRows(stepItems.filter((item) => item.kind !== 'thinking'))
    const answer = buildRows(body.slice(cut))
    const stepRowCount = countStepRows(steps)

    const live = running && index === groups.length - 1
    // Whether the turn's work is a candidate to fold. The renderer no longer
    // wraps it in a process fold — the steps show on a left rail directly under
    // the message — so this is now only the pure "did this turn do any work"
    // fact the fold's tests pin, not a per-frame open/closed decision.
    const folded = !live && (steps.length > 0 || thinking.length > 0)

    return {
      key: user !== null ? rowKey(user) : `turn:${rowKey(group[0])}`,
      user,
      thinking,
      steps,
      answer,
      stepRowCount,
      live,
      folded,
      label: foldLabel(stepItems, group, stepRowCount, timeOf),
    }
  })
}

/**
 * "Worked for 1m 35s", or a step count when the clock is unavailable.
 *
 * Measured from the first work item to the last item of the turn, both read off
 * the server's clock, so the label a reader saw before a refresh is the label
 * they see after it. `stepItems` still carries the turn's reasoning even though
 * it renders elsewhere, so the clock a thinking-only turn is measured by is not
 * lost with it.
 */
function foldLabel(
  stepItems: readonly ConversationItem[],
  group: readonly ConversationItem[],
  stepRowCount: number,
  timeOf: (item: ConversationItem) => number | null,
): string {
  let start: number | null = null
  for (const item of stepItems) {
    start = timeOf(item)
    if (start !== null) break
  }
  let end: number | null = null
  for (let index = group.length - 1; index >= 0; index -= 1) {
    end = timeOf(group[index])
    if (end !== null) break
  }
  if (start !== null && end !== null && end > start) return `Worked for ${formatDuration(end - start)}`
  // A turn that only reasoned has no steps to count; "Thought" reads better than
  // "0 steps" for the fold it still owns.
  if (stepRowCount === 0) return 'Thought'
  return stepRowCount === 1 ? '1 step' : `${stepRowCount} steps`
}

// ---------------------------------------------------------------------------
// Output caps
// ---------------------------------------------------------------------------

export interface CappedOutput {
  text: string
  /** Lines dropped off the end. Zero when nothing was. */
  hiddenLines: number
  /** The kept text was cut mid-way by the character cap. */
  clipped: boolean
}

/**
 * Bound what a tool's output can do to the page.
 *
 * The reference renders shell output in an unbounded, unscrolled `<pre>`, so
 * one `find /` turns the transcript into a scrollbar. Capping is not a display
 * preference: an aggregate line exists to make a long run readable, and a
 * single expanded row that is longer than the run defeats it.
 */
export function capToolOutput(output: string): CappedOutput {
  const lines = output.split('\n')
  const hiddenLines = Math.max(0, lines.length - OUTPUT_MAX_LINES)
  let text = hiddenLines === 0 ? output : lines.slice(0, OUTPUT_MAX_LINES).join('\n')
  const clipped = text.length > OUTPUT_MAX_CHARS
  if (clipped) text = text.slice(0, OUTPUT_MAX_CHARS)
  return { text, hiddenLines, clipped }
}
