/**
 * The standalone trace page at `/trace/:sessionId`.
 *
 * A debugging surface, not a product surface: it renders the raw envelope stream
 * a session produced, the only place raw `EventEnvelope`s are ever exposed.
 * Deliberately outside the workbench shell — no sidebar, no session chrome — so
 * it can be opened next to the conversation it explains.
 *
 * The layout is three columns under a summary bar:
 *
 * - **Left** — the event timeline, grouped by LLM turn. Lifecycle pipeline
 *   events fold into a per-group "raw events" drawer; a search box and origin
 *   filter narrow the list; an execution tree switches the *scope* between the
 *   main stream and each subagent.
 * - **Middle** — the selected event's detail: a rich `TurnView` for an LLM event,
 *   a structured `EventDetail` otherwise.
 * - **Right** — the `Inspector`: session info, context stats, subagents, a
 *   compaction overview (each card jumps back to the timeline), and artifacts.
 *
 * Two shapes are the page's whole reason for existing, both regressions the
 * deleted product had to fix:
 *
 * - **Every stream is fetched, not just the root.** The cursor is a
 *   `{task_id: last_seq}` map (`trace-stream.ts`), so a subagent's envelopes
 *   arrive with the parent's. The scope switcher then filters what is here.
 * - **`seq` collides across streams.** Each task stream counts from 0, so the
 *   timeline scopes to one stream at a time and selection is resolved within it;
 *   mixing streams would make turn grouping and seq selection cross-talk.
 */
import { useCallback, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Activity, ChevronRight, RefreshCw, Search } from 'lucide-react'
import { traceRoute } from '@/app/routes'
import type { RawEnvelope } from '@/app/types'
import { Button, cn } from '@/react-app/design-system'
import { Inspector } from './inspector'
import { JsonTree } from './json-tree'
import {
  CATEGORY_COLORS,
  actorOf,
  categoryOf,
  causationIdOf,
  clock,
  collectTaskExecution,
  compactionKindOf,
  compactionLabel,
  eventSubagentId,
  fmtDuration,
  fmtTokens,
  groupByTurn,
  idOf,
  isDrawerType,
  occurredAt,
  originOf,
  payloadOf,
  subagentLabel,
  summaryOf,
  traceIdOf,
  turnStats,
  type SubagentStatus,
  type SubagentTrace,
  type TaskExecutionTrace,
  type TurnGroup,
} from './model'
import { TraceSummary } from './trace-summary'
import { TurnView } from './turn-view'
import { useTraceStream } from './use-trace-stream'

const ORIGINS = ['all', 'engine', 'llm', 'tool', 'observer', 'system'] as const

function matches(ev: RawEnvelope, query: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  if (ev.type.toLowerCase().includes(q)) return true
  if (actorOf(ev).toLowerCase().includes(q)) return true
  try {
    return JSON.stringify(payloadOf(ev)).toLowerCase().includes(q)
  } catch {
    return false
  }
}

// ---- middle column: non-LLM event detail (header fields + payload JsonTree) ----

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 text-[12px]">
      <span className="w-24 shrink-0 font-mono text-[11px] text-ink-3">{label}</span>
      <span className="min-w-0 break-all font-mono text-[11.5px] text-ink-2">{value}</span>
    </div>
  )
}

function EventDetail({ event }: { event: RawEnvelope }) {
  const [showRaw, setShowRaw] = useState(false)
  const isCompaction = event.type === 'CompactionRequested' || event.type === 'Compacted'
  const payload = payloadOf(event)
  const at = occurredAt(event)
  const causationId = causationIdOf(event)
  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 space-y-1.5 border-b border-border px-4 py-3">
        <p className="font-mono text-[13px] font-medium text-ink">
          #{event.seq} {event.type}
          <span className={cn('ml-2 text-[10.5px]', CATEGORY_COLORS[categoryOf(event.type)])}>
            {categoryOf(event.type)}
          </span>
        </p>
        {idOf(event) ? <DetailField label="id" value={idOf(event)} /> : null}
        <DetailField label="occurred_at" value={`${clock(at)}（${at.toFixed(3)}）`} />
        <DetailField label="actor" value={actorOf(event)} />
        <DetailField label="origin" value={originOf(event)} />
        {traceIdOf(event) ? <DetailField label="trace_id" value={traceIdOf(event)} /> : null}
        {causationId ? <DetailField label="causation_id" value={causationId} /> : null}
        {isCompaction ? (
          <DetailField label="compaction" value={compactionLabel(compactionKindOf(event))} />
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <p className="mb-1.5 font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-3">
          payload
        </p>
        <div className="rounded-lg bg-surface-2 p-3">
          <JsonTree value={payload} />
        </div>
        <button
          type="button"
          onClick={() => setShowRaw((v) => !v)}
          className="mt-3 font-mono text-[10.5px] text-ink-3 hover:text-ink"
        >
          {showRaw ? 'Collapse raw JSON' : 'Expand raw JSON'}
        </button>
        {showRaw ? (
          <pre className="mt-1.5 overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-[11px] leading-relaxed text-ink-2">
            {JSON.stringify(payload, null, 2)}
          </pre>
        ) : null}
      </div>
    </div>
  )
}

// ---- left column: timeline ----

function EventRow({
  ev,
  selected,
  delta,
  owner,
  dimmed,
  onSelect,
}: {
  ev: RawEnvelope
  selected: boolean
  delta: number | null
  owner?: string
  dimmed?: boolean
  onSelect: (seq: number) => void
}) {
  const summary = summaryOf(ev)
  const compaction =
    ev.type === 'CompactionRequested' || ev.type === 'Compacted'
      ? compactionLabel(compactionKindOf(ev))
      : ''
  return (
    <button
      type="button"
      onClick={() => onSelect(ev.seq)}
      className={cn(
        'flex w-full items-start gap-2 rounded-md py-1 pl-6 pr-2 text-left transition-colors',
        selected
          ? 'bg-accent-soft'
          : compaction
            ? 'bg-warn-soft/60 hover:bg-warn-soft'
            : 'hover:bg-surface-2',
        dimmed && 'opacity-60',
      )}
    >
      <span className="w-7 shrink-0 pt-px text-right font-mono text-[10px] text-ink-3">{ev.seq}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-1.5">
          <span
            className={cn('min-w-0 truncate font-mono text-[11.5px]', CATEGORY_COLORS[categoryOf(ev.type)])}
          >
            {ev.type}
          </span>
          <span className="shrink-0 font-mono text-[10.5px] text-ink-2">{clock(occurredAt(ev))}</span>
        </span>
        {owner || compaction ? (
          <span className="mt-0.5 flex flex-wrap gap-1">
            {owner ? (
              <span className="rounded-full border border-border bg-surface px-1.5 py-0.5 font-mono text-[9.5px] text-ink-3">
                {owner}
              </span>
            ) : null}
            {compaction ? (
              <span className="rounded-full border border-warn/25 bg-warn-soft px-1.5 py-0.5 font-mono text-[9.5px] text-warn">
                {compaction}
              </span>
            ) : null}
          </span>
        ) : null}
        {summary || delta != null ? (
          <span className="flex items-baseline justify-between gap-1.5">
            <span className="min-w-0 truncate text-[10.5px] text-ink-3" title={summary}>
              {summary}
            </span>
            {delta != null ? (
              <span className="shrink-0 font-mono text-[10.5px] text-ink-2">+{delta.toFixed(2)}s</span>
            ) : null}
          </span>
        ) : null}
      </span>
    </button>
  )
}

function statusText(status: SubagentStatus | string): string {
  switch (status) {
    case 'running':
      return 'running'
    case 'completed':
      return 'done'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    case 'unknown':
      return 'unknown'
    default:
      return status || 'unknown'
  }
}

/**
 * The seq of the first LLM round in a task's events (else the first event's,
 * else null). `taskId === null` means "don't filter by task" (first turn of the
 * whole stream). Used to pick the middle column's default selection when the
 * scope changes, so the TurnView lands on that scope's first turn.
 */
function firstTurnSeq(events: RawEnvelope[], taskId: string | null): number | null {
  let firstLlm: number | null = null
  let first: number | null = null
  for (const ev of events) {
    if (taskId && ev.task_id !== taskId) continue
    if (first === null) first = ev.seq
    if (firstLlm === null && ev.type === 'LLMRequestStarted') firstLlm = ev.seq
  }
  return firstLlm ?? first
}

function statusClass(status: SubagentStatus | string): string {
  if (status === 'running') return 'text-accent'
  if (status === 'failed' || status === 'cancelled') return 'text-danger'
  if (status === 'completed') return 'text-ink-2'
  return 'text-ink-3'
}

function ExecutionTree({
  trace,
  activeTaskId,
  onSelect,
}: {
  trace: TaskExecutionTrace
  activeTaskId: string | null
  onSelect: (taskId: string | null) => void
}) {
  if (!trace.mainTaskId && trace.subagents.length === 0) return null
  // activeTaskId === null: the default main view (root stream); otherwise a subagent's task_id.
  const mainActive = activeTaskId === null
  return (
    <div className="rounded-lg border border-border bg-bg p-2">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-3">
          execution
        </span>
        <span className="font-mono text-[10px] text-ink-3">subagent · {trace.subagents.length}</span>
      </div>
      <button
        type="button"
        onClick={() => onSelect(null)}
        className={cn(
          'flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left transition-colors',
          mainActive ? 'bg-accent-soft' : 'hover:bg-surface-2',
        )}
      >
        <span className="mt-1 h-2 w-2 rounded-full bg-accent" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between gap-2">
            <span className="truncate text-[12px] font-medium text-ink">main</span>
            <span className={cn('font-mono text-[10px]', statusClass(trace.mainStatus))}>
              {statusText(trace.mainStatus)}
            </span>
          </span>
          <span className="block truncate font-mono text-[10px] text-ink-3" title={trace.mainTaskId}>
            {trace.mainTaskId || '—'} · {trace.mainEventCount} events
          </span>
        </span>
      </button>
      {trace.subagents.length > 0 ? (
        <div className="ml-2 border-l border-border pl-2">
          {trace.subagents.map((sub) => (
            <SubagentTreeRow
              key={sub.id}
              subagent={sub}
              active={activeTaskId === sub.id}
              onSelect={onSelect}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function SubagentTreeRow({
  subagent,
  active,
  onSelect,
}: {
  subagent: SubagentTrace
  active: boolean
  onSelect: (taskId: string | null) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(subagent.id)}
      className={cn(
        'flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left transition-colors',
        active ? 'bg-accent-soft' : 'hover:bg-surface-2',
      )}
    >
      <span className="mt-1 h-2 w-2 rounded-full bg-surface-3 ring-1 ring-border" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2">
          <span className="truncate text-[11.5px] font-medium text-ink" title={subagent.goal}>
            {subagentLabel(subagent)}
          </span>
          <span className={cn('font-mono text-[10px]', statusClass(subagent.status))}>
            {statusText(subagent.status)}
          </span>
        </span>
        <span
          className="block truncate text-[10.5px] text-ink-3"
          title={subagent.goal || subagent.summary}
        >
          {subagent.goal || subagent.summary || subagent.id}
        </span>
        <span className="block font-mono text-[10px] text-ink-3">
          seq {subagent.startSeq ?? '—'} → {subagent.endSeq ?? '…'} · {subagent.eventCount} events
        </span>
      </span>
    </button>
  )
}

function TurnHeaderInfo({ group }: { group: TurnGroup }) {
  const stats = turnStats(group)
  if (!stats) return null
  const parts = [
    stats.model,
    `${fmtTokens(stats.tokensIn)}→${fmtTokens(stats.tokensOut)} tok`,
    ...(stats.costUsd > 0 ? [`$${stats.costUsd.toFixed(4)}`] : []),
    fmtDuration(stats.durationS),
  ]
  const text = parts.join(' · ')
  return (
    <span className="min-w-0 truncate font-mono text-[10px] text-ink-3" title={text}>
      {text}
    </span>
  )
}

// ---- page ----

/** `null` is "the main stream" (root task); otherwise a subagent's task_id. */
type Scope = string | null

/** Jump to another session's trace by id. Kept in the header for quick pivoting. */
function SessionJump({ onSubmit }: { onSubmit: (id: string) => void }) {
  const [value, setValue] = useState('')
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        const id = value.trim()
        if (id) onSubmit(id)
      }}
      className="relative w-48"
    >
      <Search
        className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-ink-3"
        aria-hidden="true"
      />
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Open another session's trace…"
        className="w-full rounded-lg border border-border bg-bg py-1 pl-7 pr-2 text-[12px] text-ink outline-none placeholder:text-ink-3 focus:border-accent"
      />
    </form>
  )
}

export function TracePage() {
  const { sessionId = '' } = useParams()
  const navigate = useNavigate()
  const { state, status, error, live, setLive, refresh } = useTraceStream(sessionId)
  const events = state.events

  const [selectedSeq, setSelectedSeq] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  const [origin, setOrigin] = useState<string>('all')
  const [toggled, setToggled] = useState<Record<number, boolean>>({})
  const [drawerOpen, setDrawerOpen] = useState<Record<number, boolean>>({})
  // Timeline scope: null = main (root task's events); otherwise one subagent's task_id.
  const [scopeTaskId, setScopeTaskId] = useState<Scope>(null)

  // The execution tree / Inspector / TraceSummary read the full event set (all
  // streams — totals are a whole-session figure); the timeline looks at one
  // stream at a time: main by default, a subagent when picked. Each stream's seq
  // counts independently, so mixing them would cross-talk turn grouping and selection.
  const executionTrace = useMemo(() => collectTaskExecution(events), [events])
  const scopedEvents = useMemo(() => {
    const tid = scopeTaskId ?? executionTrace.mainTaskId
    return tid ? events.filter((ev) => ev.task_id === tid) : events
  }, [events, scopeTaskId, executionTrace.mainTaskId])
  const scopedSubagent = scopeTaskId
    ? executionTrace.subagents.find((s) => s.id === scopeTaskId)
    : undefined
  const scopeLabel = scopedSubagent ? subagentLabel(scopedSubagent) : null

  // Grouping is over scoped events (stable groups); the filter only decides which
  // rows inside a group are visible.
  const groups = useMemo(() => groupByTurn(scopedEvents), [scopedEvents])
  const subagentIds = useMemo(
    () => new Set(executionTrace.subagents.map((subagent) => subagent.id)),
    [executionTrace],
  )
  const subagentLabels = useMemo(() => {
    const map = new Map<string, string>()
    for (const subagent of executionTrace.subagents) map.set(subagent.id, subagentLabel(subagent))
    return map
  }, [executionTrace])
  const hasFilter = query !== '' || origin !== 'all'
  const matchedSeqs = useMemo(() => {
    if (!hasFilter) return null
    const set = new Set<number>()
    for (const ev of scopedEvents) {
      if ((origin === 'all' || originOf(ev) === origin) && matches(ev, query)) set.add(ev.seq)
    }
    return set
  }, [scopedEvents, query, origin, hasFilter])

  // Inter-event gap: seq → time since the previous (scoped) event.
  const deltas = useMemo(() => {
    const map = new Map<number, number>()
    for (let i = 1; i < scopedEvents.length; i++) {
      map.set(scopedEvents[i].seq, occurredAt(scopedEvents[i]) - occurredAt(scopedEvents[i - 1]))
    }
    return map
  }, [scopedEvents])

  // owner badge: on the default full view, tag which subagent an event belongs to;
  // once scoped to a subagent, its own events share the owner and are not re-tagged.
  const ownerFor = useCallback(
    (ev: RawEnvelope): string => {
      const id = eventSubagentId(ev, subagentIds)
      if (!id || id === scopeTaskId) return ''
      return subagentLabels.get(id) ?? ''
    },
    [subagentIds, subagentLabels, scopeTaskId],
  )

  // Switch scope: null = back to main (root stream); otherwise a subagent. If the
  // current selection is not in the new scope, jump to that scope's first turn so
  // the middle column lands on a turn. Collapsed state keys on group-first seq,
  // which collides across streams, so it is cleared on scope change.
  const handleScopeSelect = useCallback(
    (taskId: string | null) => {
      setScopeTaskId(taskId)
      setToggled({})
      setDrawerOpen({})
      const tid = taskId ?? executionTrace.mainTaskId
      setSelectedSeq((cur) => {
        if (cur != null && events.some((ev) => ev.seq === cur && (!tid || ev.task_id === tid))) {
          return cur
        }
        return firstTurnSeq(events, tid || null)
      })
    },
    [events, executionTrace.mainTaskId],
  )

  // Inspector compaction-card jump: seq collides across streams, so switch scope
  // by taskId first, then select; open the target's turn group so the row is visible.
  const handleCompactionJump = useCallback(
    (taskId: string, seq: number) => {
      setScopeTaskId(taskId === executionTrace.mainTaskId ? null : taskId)
      setDrawerOpen({})
      const scoped = events.filter((ev) => ev.task_id === taskId)
      const group = groupByTurn(scoped).find((g) => g.events.some((e) => e.seq === seq))
      setToggled(group ? { [group.id]: true } : {})
      setSelectedSeq(seq)
    },
    [events, executionTrace.mainTaskId],
  )

  const visibleGroups = useMemo(() => {
    if (!matchedSeqs) return groups
    return groups
      .map((g) => ({ group: g, visible: g.events.filter((e) => matchedSeqs.has(e.seq)) }))
      .filter((x) => x.visible.length > 0)
      .map((x) => x.group)
  }, [groups, matchedSeqs])

  const lastGroupId = visibleGroups[visibleGroups.length - 1]?.id
  // Find the selected event within the scope: seq collides across streams, so a
  // find over the full set could hit a different stream.
  const selected = scopedEvents.find((ev) => ev.seq === selectedSeq) ?? null
  const selectedGroup = selected
    ? (groups.find((g) => g.events.some((e) => e.seq === selected.seq)) ?? null)
    : null
  const showTurnView =
    selected != null &&
    selectedGroup?.kind === 'turn' &&
    selectedGroup.round != null &&
    categoryOf(selected.type) === 'llm'

  return (
    <div className="flex h-screen flex-col bg-bg">
      {/* header */}
      <div className="flex h-[52px] shrink-0 items-center gap-2 border-b border-border px-4">
        <Activity className="size-4 shrink-0 text-accent" aria-hidden="true" />
        <span className="font-medium text-ink">Trace</span>
        <span className="truncate font-mono text-xs text-ink-3" title={sessionId}>
          {sessionId}
        </span>
        <span className="ml-auto text-xs text-ink-3">
          {events.length} envelope{events.length === 1 ? '' : 's'}
        </span>
        <SessionJump onSubmit={(id) => navigate(traceRoute(id))} />
        <Button size="sm" variant="ghost" onClick={() => setLive(!live)}>
          {live ? 'Pause' : 'Resume'}
        </Button>
        <Button size="sm" variant="ghost" onClick={refresh} className="gap-1.5">
          <RefreshCw className={cn('size-3.5', status === 'loading' && 'animate-spin')} aria-hidden="true" />
          Refresh
        </Button>
      </div>

      <TraceSummary events={events} />

      <div className="flex min-h-0 flex-1">
        {/* left: event timeline */}
        <div className="flex w-80 shrink-0 flex-col border-r border-border">
          <div className="shrink-0 space-y-2 border-b border-border p-2.5">
            <div className="relative">
              <Search
                className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-ink-3"
                aria-hidden="true"
              />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search event type / payload…"
                className="w-full rounded-lg border border-border bg-bg py-1.5 pl-7 pr-2 text-[12px] text-ink outline-none placeholder:text-ink-3 focus:border-accent"
              />
            </div>
            <select
              value={origin}
              onChange={(e) => setOrigin(e.target.value)}
              className="w-full cursor-pointer rounded-lg border border-border bg-bg px-2 py-1 font-mono text-[11px] text-ink-2 outline-none focus:border-accent"
            >
              {ORIGINS.map((o) => (
                <option key={o} value={o}>
                  {o === 'all' ? 'origin: all' : `origin: ${o}`}
                </option>
              ))}
            </select>
            <ExecutionTree trace={executionTrace} activeTaskId={scopeTaskId} onSelect={handleScopeSelect} />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {error !== null ? (
              <div className="m-1.5 space-y-2 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2">
                <p className="text-[12px] text-danger">{error}</p>
                <Button size="sm" variant="ghost" onClick={refresh}>
                  Try again
                </Button>
              </div>
            ) : null}
            {error === null && visibleGroups.length === 0 ? (
              <p className="p-4 text-center text-[12.5px] text-ink-3">
                {status === 'loading'
                  ? 'Loading…'
                  : events.length > 0
                    ? 'No matching events.'
                    : 'No events yet.'}
              </p>
            ) : null}
            {visibleGroups.map((g) => {
              const open = toggled[g.id] ?? g.id === lastGroupId
              const visible = matchedSeqs ? g.events.filter((e) => matchedSeqs.has(e.seq)) : g.events
              // Under a filter the drawer is not used (matched events show directly).
              const drawer = matchedSeqs ? [] : visible.filter((e) => isDrawerType(e.type))
              const main = matchedSeqs ? visible : visible.filter((e) => !isDrawerType(e.type))
              const dOpen = drawerOpen[g.id] ?? false
              return (
                <div key={g.id} className="mb-0.5">
                  <button
                    type="button"
                    onClick={() => setToggled((t) => ({ ...t, [g.id]: !open }))}
                    className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left hover:bg-surface-2"
                  >
                    <ChevronRight
                      className={cn('size-3 shrink-0 text-ink-3 transition-transform', open && 'rotate-90')}
                      aria-hidden="true"
                    />
                    <span className="shrink-0 text-[12px] font-medium text-ink">{g.label}</span>
                    <TurnHeaderInfo group={g} />
                    <span className="ml-auto shrink-0 font-mono text-[10px] text-ink-3">
                      {visible.length}
                    </span>
                  </button>
                  {open ? (
                    <ul>
                      {drawer.length > 0 ? (
                        <li>
                          <button
                            type="button"
                            onClick={() => setDrawerOpen((d) => ({ ...d, [g.id]: !dOpen }))}
                            className="flex w-full items-center gap-1.5 rounded-md py-1 pl-6 pr-2 text-left hover:bg-surface-2"
                          >
                            <ChevronRight
                              className={cn(
                                'size-2.5 shrink-0 text-ink-3 transition-transform',
                                dOpen && 'rotate-90',
                              )}
                              aria-hidden="true"
                            />
                            <span className="font-mono text-[10.5px] text-ink-3">
                              raw events · {drawer.length}
                            </span>
                          </button>
                          {dOpen
                            ? drawer.map((ev) => (
                                <EventRow
                                  key={ev.seq}
                                  ev={ev}
                                  selected={selectedSeq === ev.seq}
                                  delta={deltas.get(ev.seq) ?? null}
                                  owner={ownerFor(ev)}
                                  dimmed
                                  onSelect={setSelectedSeq}
                                />
                              ))
                            : null}
                        </li>
                      ) : null}
                      {main.map((ev) => (
                        <li key={ev.seq}>
                          <EventRow
                            ev={ev}
                            selected={selectedSeq === ev.seq}
                            delta={deltas.get(ev.seq) ?? null}
                            owner={ownerFor(ev)}
                            onSelect={setSelectedSeq}
                          />
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              )
            })}
          </div>
        </div>

        {/* middle: turn / event detail */}
        <div className="min-w-0 flex-1 overflow-hidden">
          {selected == null ? (
            <p className="p-6 text-center text-[12.5px] text-ink-3">
              Select an event in the timeline on the left to see its details.
            </p>
          ) : showTurnView ? (
            <TurnView
              // Remount on turn change so a MessageCard's collapsed state does not
              // leak across turns (the group id is the LLMRequestStarted.seq — stable).
              key={selectedGroup!.id}
              round={selectedGroup!.round!}
              turnEvents={selectedGroup!.events}
              turnLabel={scopeLabel ? `${scopeLabel} · ${selectedGroup!.label}` : selectedGroup!.label}
              selected={selected}
            />
          ) : (
            <EventDetail event={selected} />
          )}
        </div>

        {/* right: Inspector */}
        <div className="flex w-72 shrink-0 flex-col border-l border-border">
          <div className="shrink-0 border-b border-border px-3 py-2">
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-3">
              Inspector
            </span>
          </div>
          <Inspector events={events} session={null} onJump={handleCompactionJump} />
        </div>
      </div>
    </div>
  )
}
