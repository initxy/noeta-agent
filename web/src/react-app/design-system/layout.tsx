import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from './cn'

/**
 * The workbench frame: a full-viewport row that never scrolls itself. Scroll
 * belongs to the panes, so a long conversation cannot push the sidebar or the
 * composer off screen.
 */
export function AppFrame({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex h-screen w-full overflow-hidden bg-bg', className)} {...props} />
}

/**
 * The sidebar rail. Collapsible: `w-64` expanded, a `w-10` strip collapsed —
 * the width transitions so the collapse reads as the same gesture as the right
 * panel's. The rail owns the width; `Sidebar` decides what renders inside it at
 * each state.
 */
export function SidebarRail({
  className,
  collapsed,
  ...props
}: HTMLAttributes<HTMLElement> & { collapsed?: boolean }) {
  return (
    <aside
      className={cn(
        'flex shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-200',
        collapsed ? 'w-10' : 'w-64',
        className,
      )}
      {...props}
    />
  )
}

export function RailSection({
  title,
  children,
  className,
}: {
  title: string
  children?: ReactNode
  className?: string
}) {
  return (
    <section className={cn('px-2 py-3', className)}>
      <h2 className="px-2 pb-1.5 text-[11px] font-semibold tracking-wide text-ink-3 uppercase">
        {title}
      </h2>
      {children}
    </section>
  )
}

/** The main pane. `min-w-0` so a wide child truncates instead of stretching the row. */
export function MainPane({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <main className={cn('flex min-w-0 flex-1 flex-col overflow-hidden', className)} {...props} />
}

/**
 * A pane's header. `h-[52px]` is the workbench's master alignment line: the
 * sidebar brand header and the panel dock's top bar share it, so the top border
 * reads as one continuous hairline across all three columns.
 */
export function PaneHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex h-[52px] shrink-0 items-center gap-2 border-b border-border px-4 text-sm text-ink-2',
        className,
      )}
      {...props}
    />
  )
}

export function PaneBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('min-h-0 flex-1 overflow-auto', className)} {...props} />
}

/** A centred message for empty and loading states. */
export function CenteredNote({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-8 text-sm text-ink-3">{children}</div>
  )
}
