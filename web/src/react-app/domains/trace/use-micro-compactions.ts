/**
 * Per-plan digests folded from `ContextPlanComposed`, for the Inspector.
 *
 * A compose emits no event of its own — its only trace is the `plan_ref` on
 * each `ContextPlanComposed`, whose body carries both `cleared_outputs` (micro
 * compaction: tool outputs offloaded when the request nears the window) and
 * `segment_hashes` (the cold/hot three-tier layering). To show "every
 * compaction at a glance" and "was the prefix cache reusable this turn" the
 * Inspector must dereference every plan and read those fields, which this hook
 * does — fetching per plan but keeping only the digest (never the body), cached
 * by hash at module level so the same immutable plan is fetched once across
 * incremental refreshes and re-entries. Failures are not cached, so they can be
 * retried.
 */
import { useEffect, useState } from 'react'
import { contentUrl } from '@/app/api'
import type { RawEnvelope } from '@/app/types'
import { isContentRef, occurredAt } from './model'

/**
 * One compose's audit digest: how many tool outputs it cleared, plus the three
 * segment hashes so a caller can tell whether the prefix (and thus the prompt
 * cache) held across turns. `cleared === 0` is normal (pruning only arms near
 * the window); such a plan is still a digest, just not a micro compaction.
 */
export interface PlanDigest {
  /** Owning task stream (seq collides across streams; a jump must switch scope first). */
  taskId: string
  /** The ContextPlanComposed event's seq. */
  seq: number
  occurredAt: number
  /** How many tool outputs this compose cleared (cleared_outputs length). */
  cleared: number
  /** segment_hashes.stable_prefix — the cache-anchored cold prefix (may be ''). */
  stableHash: string
  /** segment_hashes.semi_stable (may be ''). */
  semiHash: string
  /** segment_hashes.dynamic_suffix — the per-turn hot tail (may be ''). */
  dynamicHash: string
}

/** A micro compaction is a plan that actually pruned (`cleared > 0`). Callers
 * derive the list from `usePlanDigests` (`.filter(d => d.cleared > 0)`). */
export interface MicroCompaction {
  taskId: string
  seq: number
  occurredAt: number
  cleared: number
}

/** The plan-body shape this hook reads; everything is optional/defensive. */
interface PlanBody {
  cleared_outputs?: unknown[]
  segment_hashes?: Record<string, unknown>
}

const digestCache = new Map<string, Promise<{ cleared: number; segs: Record<string, string> }>>()

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function fetchPlanDigest(
  hash: string,
): Promise<{ cleared: number; segs: Record<string, string> }> {
  const hit = digestCache.get(hash)
  if (hit) return hit
  const promise = fetch(contentUrl(hash), { headers: { Accept: '*/*' } }).then(async (res) => {
    if (!res.ok) throw new Error(`Failed to load plan (${res.status})`)
    const plan = JSON.parse(await res.text()) as PlanBody
    const cleared = Array.isArray(plan.cleared_outputs) ? plan.cleared_outputs.length : 0
    const raw = plan.segment_hashes ?? {}
    const segs: Record<string, string> = {
      stable_prefix: str(raw.stable_prefix),
      semi_stable: str(raw.semi_stable),
      dynamic_suffix: str(raw.dynamic_suffix),
    }
    return { cleared, segs }
  })
  promise.catch(() => digestCache.delete(hash))
  digestCache.set(hash, promise)
  return promise
}

/**
 * Every `ContextPlanComposed`'s digest, by occurrence time.
 *
 * Dereferencing is async: the first frame returns `[]`, and the list lands once
 * all plans resolve. A plan whose ref cannot be read is dropped rather than
 * failing the batch.
 */
export function usePlanDigests(events: RawEnvelope[]): PlanDigest[] {
  const [list, setList] = useState<PlanDigest[]>([])

  useEffect(() => {
    let alive = true
    const plans = events.filter((ev) => ev.type === 'ContextPlanComposed')
    if (plans.length === 0) {
      setList([])
      return
    }
    void Promise.all(
      plans.map(async (ev): Promise<PlanDigest | null> => {
        const payload = (ev as { payload?: unknown }).payload as Record<string, unknown> | null
        const ref = payload?.plan_ref
        if (!isContentRef(ref)) return null
        try {
          const { cleared, segs } = await fetchPlanDigest(ref.hash)
          return {
            taskId: ev.task_id,
            seq: ev.seq,
            occurredAt: occurredAt(ev),
            cleared,
            stableHash: segs.stable_prefix,
            semiHash: segs.semi_stable,
            dynamicHash: segs.dynamic_suffix,
          }
        } catch {
          return null
        }
      }),
    ).then((resolved) => {
      if (!alive) return
      setList(
        resolved
          .filter((m): m is PlanDigest => m !== null)
          .sort((a, b) => a.occurredAt - b.occurredAt),
      )
    })
    return () => {
      alive = false
    }
  }, [events])

  return list
}
