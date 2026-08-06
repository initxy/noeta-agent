/**
 * A workspace path, as a chip.
 *
 * **A raw path is never rendered in the transcript.** Inside a container an
 * absolute path is four times the width of the only part that identifies the
 * file, and it pushes everything else off the line — so the chip shows the
 * basename and keeps the full path in the tooltip, where someone who needs to
 * know *which* `index.ts` can ask for it.
 *
 * Phase 5 makes the chip open the file in the artifact panel; it stays a
 * `<span>` until there is somewhere to open it, because a control that does
 * nothing is worse than a label.
 */

import { basename } from '@/app/fold/aggregate'
import { cn } from '@/react-app/design-system'

export function FileChip({ path, className }: { path: string; className?: string }) {
  return (
    <span
      title={path}
      data-file-chip={path}
      className={cn(
        'inline-flex max-w-full min-w-0 items-baseline rounded border border-border bg-surface-2 px-1 font-mono text-[11px] text-ink-2',
        className,
      )}
    >
      <span className="truncate">{basename(path)}</span>
    </span>
  )
}
