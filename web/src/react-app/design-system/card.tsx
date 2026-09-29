import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from './cn'

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-lg border border-border bg-surface p-4 shadow-card', className)}
      {...props}
    />
  )
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn('text-sm font-semibold text-ink', className)} {...props} />
}

export function CardDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('mt-1 text-sm leading-relaxed text-ink-2', className)} {...props} />
}

/**
 * The not-found card.
 *
 * Presentational only: the copy and the decision to show it belong to the
 * route that resolved the id. What this primitive guarantees is the part that
 * matters structurally — it renders *inside* the main pane, so the sidebar
 * stays mounted and the user can pick something else instead of being dropped
 * on a dead page.
 */
export function NotFoundCard({
  title,
  message,
  action,
}: {
  title: string
  message: string
  action?: ReactNode
}) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <Card className="max-w-md text-center">
        <CardTitle>{title}</CardTitle>
        <CardDescription>{message}</CardDescription>
        {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
      </Card>
    </div>
  )
}
