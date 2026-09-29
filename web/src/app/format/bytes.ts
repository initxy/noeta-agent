/**
 * Human-readable byte sizes.
 *
 * One formatter for the whole app: the workbench had three near-identical
 * copies with two different spacing conventions ("2.0 KB" vs "2.0KB"), and the
 * files panel showed raw byte counts (a 2 KB file read as "2048"). This is the
 * single source of truth — the spaced form, because that is what the majority
 * of call sites already used and what the file surfaces render.
 *
 * `null` returns the empty string, not "0 B": a caller renders the result
 * straight into JSX, and an unknown size is nothing to show rather than a
 * confident zero.
 */
export function formatBytes(size: number | null): string {
  if (size === null) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}
