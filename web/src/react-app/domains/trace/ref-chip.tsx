/**
 * A clickable chip for a `ContentRef`, with automatic deref on expand.
 *
 * Collapsed, it shows label / media type / size / short hash and costs nothing.
 * Expanded, it dereferences the body (`useContentBody`) and renders JSON through
 * the shared `JsonTree`, a nested ref recursively as another chip, and long text
 * clamped. This is the auto-deref-on-expand companion to `content-ref-chip.tsx`,
 * which resolves a blob only on an explicit click and renders from a different
 * ref shape (`ContentRefInfo` vs the payload's `ContentRefJson`).
 */
import { useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/react-app/design-system'
import { ClampText } from './clamp-text'
import { JsonTree } from './json-tree'
import { fmtSize, type ContentRefJson } from './model'
import { useContentBody } from './use-content-body'

interface RefChipProps {
  refJson: ContentRefJson
  /** A prefix label, e.g. request / response / plan. */
  label?: string
  className?: string
}

export function RefChip({ refJson, label, className }: RefChipProps) {
  const [open, setOpen] = useState(false)
  return (
    <div className={cn('min-w-0', className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 py-0.5 font-mono text-[10.5px] transition-colors hover:border-accent',
          open ? 'text-ink' : 'text-ink-2',
        )}
      >
        <ChevronRight
          className={cn('h-2.5 w-2.5 shrink-0 text-ink-3 transition-transform', open && 'rotate-90')}
          aria-hidden="true"
        />
        {label ? <span className="shrink-0 font-medium text-ink">{label}</span> : null}
        <span className="shrink-0">{refJson.media_type}</span>
        <span className="shrink-0 text-ink-3">{fmtSize(refJson.size)}</span>
        <span className="truncate text-ink-3">{refJson.hash.slice(0, 8)}</span>
      </button>
      {open ? <RefBody refJson={refJson} /> : null}
    </div>
  )
}

function RefBody({ refJson }: { refJson: ContentRefJson }) {
  const { body, loading, error } = useContentBody(refJson.hash)
  const parsed = useMemo(() => {
    if (body == null || !refJson.media_type.includes('json')) return undefined
    try {
      return JSON.parse(body) as unknown
    } catch {
      return undefined
    }
  }, [body, refJson.media_type])

  if (loading) {
    return <p className="mt-1 pl-2 font-mono text-[11px] text-ink-3">Loading…</p>
  }
  if (error) {
    return <p className="mt-1 pl-2 font-mono text-[11px] text-danger">{error}</p>
  }
  if (body == null) return null
  return (
    <div className="mt-1 overflow-x-auto rounded-lg border border-border bg-surface-2 p-2.5">
      {parsed !== undefined ? <JsonTree value={parsed} /> : <ClampText text={body} />}
    </div>
  )
}
