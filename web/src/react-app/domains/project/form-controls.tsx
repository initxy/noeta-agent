/**
 * Form primitives, scoped to the project domain.
 *
 * They live here rather than in `design-system/` for a reason worth stating:
 * the design system is where a primitive lands once a second surface needs it,
 * and until then a shared component is a guess about a caller that does not
 * exist yet. The composer, the connector form and the settings tabs will
 * disagree about focus, sizing and validation display; when two of them
 * actually agree, these move down a layer.
 *
 * Everything is uncontrolled-friendly and label-bound: every control has a
 * real `<label htmlFor>`, which is what makes the surfaces reachable by
 * keyboard and by name from a test.
 */

import { useId } from 'react'
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'
import { cn } from '@/react-app/design-system'

const CONTROL_CLASS =
  'w-full rounded-md border border-border-strong bg-surface px-2.5 py-1.5 text-sm text-ink ' +
  'placeholder:text-ink-3 outline-none focus-visible:ring-2 focus-visible:ring-accent ' +
  'disabled:opacity-50'

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: string
  hint?: ReactNode
  error?: string | null
  children: ReactNode
  htmlFor?: string
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-xs font-medium text-ink-2">
        {label}
      </label>
      {children}
      {hint ? <p className="text-xs leading-relaxed text-ink-3">{hint}</p> : null}
      {error ? (
        <p role="alert" className="text-xs leading-relaxed text-danger">
          {error}
        </p>
      ) : null}
    </div>
  )
}

export function TextField({
  label,
  hint,
  error,
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string
  hint?: ReactNode
  error?: string | null
}) {
  const id = useId()
  return (
    <Field label={label} hint={hint} error={error} htmlFor={id}>
      <input
        id={id}
        // `aria-invalid` rather than a red border alone: the border is
        // invisible to a screen reader and to a test asserting the field.
        aria-invalid={error ? true : undefined}
        className={cn(CONTROL_CLASS, error && 'border-danger', className)}
        {...props}
      />
    </Field>
  )
}

export function TextAreaField({
  label,
  hint,
  error,
  className,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label: string
  hint?: ReactNode
  error?: string | null
}) {
  const id = useId()
  return (
    <Field label={label} hint={hint} error={error} htmlFor={id}>
      <textarea id={id} className={cn(CONTROL_CLASS, 'min-h-24 resize-y', className)} {...props} />
    </Field>
  )
}

export function SelectField({
  label,
  hint,
  error,
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & {
  label: string
  hint?: ReactNode
  error?: string | null
}) {
  const id = useId()
  return (
    <Field label={label} hint={hint} error={error} htmlFor={id}>
      <select id={id} className={cn(CONTROL_CLASS, className)} {...props}>
        {children}
      </select>
    </Field>
  )
}

export function CheckboxField({
  label,
  hint,
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: ReactNode }) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="checkbox"
          className={cn('size-3.5 accent-[var(--accent)]', className)}
          {...props}
        />
        <label htmlFor={id} className="text-sm text-ink-2">
          {label}
        </label>
      </div>
      {hint ? <p className="pl-5.5 text-xs leading-relaxed text-ink-3">{hint}</p> : null}
    </div>
  )
}

/** A settings block: one heading, one explanation, one group of controls. */
export function SettingsSection({
  title,
  description,
  children,
  footer,
}: {
  title: string
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <section className="flex flex-col gap-3 border-b border-border px-6 py-5 last:border-b-0">
      <div>
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        {description ? (
          <p className="mt-1 max-w-prose text-xs leading-relaxed text-ink-3">{description}</p>
        ) : null}
      </div>
      {children}
      {footer ? <div className="flex items-center gap-2">{footer}</div> : null}
    </section>
  )
}

/**
 * A callout. `tone="warn"` is the one used for the local-tier statement, so it
 * is styled to be read rather than skipped — this is the product telling the
 * user what it is allowed to do to their machine.
 */
export function Callout({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warn' | 'danger'
  children: ReactNode
}) {
  const toneClass =
    tone === 'warn'
      ? 'border-warn/40 bg-warn-soft text-ink'
      : tone === 'danger'
        ? 'border-danger/40 bg-danger-soft text-ink'
        : 'border-border bg-surface-2 text-ink-2'
  return (
    <p className={cn('rounded-md border px-3 py-2 text-xs leading-relaxed', toneClass)}>
      {children}
    </p>
  )
}
