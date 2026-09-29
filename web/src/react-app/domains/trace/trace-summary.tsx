/**
 * The trace summary bar, spanning the three columns.
 *
 * model / event count / LLM rounds / subagents / summary compactions / tokens
 * (with a cache-hit rate that always shows, 0% included) / cost / start time /
 * total duration — all folded from the raw event stream by `traceTotals`.
 */
import { useMemo } from 'react'
import type { RawEnvelope } from '@/app/types'
import { clock, fmtDuration, fmtTokens, occurredAt, traceTotals } from './model'

function Stat({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex min-w-0 items-baseline gap-1.5">
      <span className="shrink-0 text-[11px] text-ink-3">{label}</span>
      <span className={'truncate text-[12px] text-ink' + (mono ? ' font-mono' : '')} title={value}>
        {value}
      </span>
    </div>
  )
}

export function TraceSummary({ events }: { events: RawEnvelope[] }) {
  const t = useMemo(() => traceTotals(events), [events])
  if (events.length === 0) return null
  // Always show a cache reading, 0% included: a hidden figure reads as "no cache
  // feature", when it usually means a cold prefix / first turn / the offline mock.
  const cacheRate =
    t.tokensIn > 0
      ? t.cacheRead > 0
        ? `(cache ${Math.round((t.cacheRead / t.tokensIn) * 100)}%)`
        : '(cache 0% miss)'
      : ''
  const startAt = occurredAt(events[0])
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-1 border-b border-border bg-surface px-4 py-2">
      {t.model ? <Stat label="model" value={t.model} /> : null}
      <Stat label="events" value={String(t.events)} />
      <Stat label="LLM rounds" value={String(t.rounds)} />
      {t.subagents > 0 ? <Stat label="subagent" value={String(t.subagents)} /> : null}
      {t.summaryCompactions > 0 ? (
        <Stat label="summary compaction" value={String(t.summaryCompactions)} />
      ) : null}
      <Stat
        label="tokens"
        value={`${fmtTokens(t.tokensIn)} in · ${fmtTokens(t.tokensOut)} out${cacheRate}`}
      />
      {t.costUsd > 0 ? <Stat label="cost" value={`$${t.costUsd.toFixed(4)}`} /> : null}
      <Stat label="start" value={clock(startAt)} />
      <Stat label="total time" value={fmtDuration(t.durationS)} />
    </div>
  )
}
