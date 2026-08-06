/**
 * The Inspector's "Context & cache" block: the one place a reader can see, in plain
 * language, what happened to this session's context window — when it ran and for
 * how long, how much of the prompt hit the cache, whether the prefix cache could
 * still be reused, and both kinds of compaction (micro: old tool outputs cleared
 * as the window filled; macro: messages folded into a summary).
 *
 * All of it is folded from data already on the raw stream — the cache figures
 * from `LLMRequestFinished.usage`, the compactions from `ContextPlanComposed`
 * plan digests and `Compacted` events. Nothing here is a new wire field; the
 * block only surfaces what the timeline buried.
 */
import { cn } from '@/react-app/design-system'
import type { RawEnvelope } from '@/app/types'
import {
  clock,
  fmtDuration,
  fmtTokens,
  occurredAt,
  prefixCacheStatus,
  type CompactionTrace,
  type PrefixCacheStatus,
  type TraceTotals,
} from './model'
import type { PlanDigest } from './use-micro-compactions'

/** One label/value line; the value is readable ink, not the faint timeline grey. */
function Line({
  label,
  value,
  tone,
  hint,
}: {
  label: string
  value: string
  tone?: 'accent' | 'warn' | 'muted'
  hint?: string
}) {
  return (
    <div className="flex items-start justify-between gap-2 py-1 text-[12px]" title={hint}>
      <span className="shrink-0 text-ink-3">{label}</span>
      <span
        className={cn(
          'min-w-0 break-words text-right font-mono text-[11.5px]',
          tone === 'accent'
            ? 'text-accent'
            : tone === 'warn'
              ? 'text-warn'
              : tone === 'muted'
                ? 'text-ink-3'
                : 'text-ink',
        )}
      >
        {value}
      </span>
    </div>
  )
}

function prefixCacheLine(status: PrefixCacheStatus): { value: string; tone: 'accent' | 'warn' } | null {
  if (status === 'stable') return { value: '✓ Prefix stable, can hit', tone: 'accent' }
  if (status === 'invalidated') return { value: '⚠ Prefix changed, invalidated this round', tone: 'warn' }
  return null
}

export function ContextCachePanel({
  events,
  totals,
  macros,
  digests,
  mainTaskId,
}: {
  events: RawEnvelope[]
  totals: TraceTotals
  macros: CompactionTrace[]
  digests: PlanDigest[]
  mainTaskId: string
}) {
  if (events.length === 0) return null
  const first = events[0]
  const last = events[events.length - 1]
  const startAt = occurredAt(first)
  const endAt = occurredAt(last)

  const cachePct =
    totals.tokensIn > 0 ? Math.round((totals.cacheRead / totals.tokensIn) * 100) : 0
  const cacheValue =
    cachePct > 0
      ? `hit ${cachePct}% (${fmtTokens(totals.cacheRead)} tok)`
      : `miss 0%`

  const prefix = prefixCacheLine(prefixCacheStatus(digests, mainTaskId))

  const microCleared = digests.reduce((sum, d) => sum + d.cleared, 0)
  const microValue = microCleared > 0 ? `cleared ${microCleared} old tool outputs` : 'none'

  const macroFolded = macros.reduce((sum, m) => sum + (m.replacedCount ?? 0), 0)
  const macroKinds = new Set(macros.map((m) => m.kind))
  const macroReason = macroKinds.has('passive')
    ? macroKinds.has('proactive')
      ? 'proactive + overflow fallback'
      : 'overflow fallback'
    : macroKinds.has('proactive')
      ? 'proactive'
      : ''
  const macroValue =
    macros.length > 0
      ? `folded ${macroFolded} messages${macroReason ? ` (${macroReason})` : ''}`
      : 'none'

  return (
    <>
      <p className="mb-1 mt-0 font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-3">
        Context & cache
      </p>
      <Line label="start" value={clock(startAt)} />
      <Line label="duration" value={`${fmtDuration(totals.durationS)} · to ${clock(endAt)}`} tone="muted" />
      <Line
        label="cache hit"
        value={cacheValue}
        tone={cachePct > 0 ? 'accent' : 'muted'}
        hint="Share of input tokens that hit the prompt cache across this session's LLM requests (real gateways only; the offline mock is always 0)"
      />
      {prefix ? (
        <Line
          label="prefix cache"
          value={prefix.value}
          tone={prefix.tone}
          hint="Compares the cold-prefix (stable_prefix) hash of the last two rounds: unchanged means the gateway's KV-cache prefix can keep hitting; changed means everything after that prefix is recomputed this round"
        />
      ) : null}
      <Line
        label="micro-compaction"
        value={microValue}
        tone={microCleared > 0 ? 'accent' : 'muted'}
        hint="As context nears the model's window limit, tool-call results from earlier messages are offloaded to free space (the recent tail is kept); does not trigger while there is headroom"
      />
      <Line
        label="summary compaction"
        value={macroValue}
        tone={macros.length > 0 ? 'warn' : 'muted'}
        hint="When context overflows, a batch of history messages is folded into one summary; proactive = overflow predicted before the request, overflow fallback = recovery after the gateway already reported overflow"
      />
    </>
  )
}
