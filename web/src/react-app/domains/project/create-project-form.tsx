/**
 * Creating a project — the product's real first-run path.
 *
 * Three things have to be true before the request is sent, and each is a
 * decision rather than a formality:
 *
 * - **The directory is absolute.** Checked here so the answer is immediate and
 *   the request never happens (`directory.ts`).
 * - **The execution tier is chosen deliberately.** `local` is the default
 *   because it is what works on a machine with no Docker, and it is exactly
 *   the tier that runs the agent unsandboxed — so its consequences are stated
 *   next to the control, not behind a disclosure triangle (`tier-copy.ts`).
 * - **The directory is shared by every session in the project** (D2). Said
 *   here because this is the only screen where the directory is chosen.
 */

import { useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { projectSessionRoute } from '@/app/routes'
import type { ExecutionTier } from '@/app/types'
import { isApiError } from '@/app/api'
import { Button, cn } from '@/react-app/design-system'
import { projectsRoot, useHealth } from '@/react-app/infra/health-query'
import { checkProjectDirectory, suggestProjectDirectory } from './directory'
import { Callout, CheckboxField, TextField } from './form-controls'
import { useCreateProject } from './project-queries'
import {
  EXECUTION_TIERS,
  SANDBOX_UNAVAILABLE_NOTE,
  SHARED_DIRECTORY_NOTE,
  TIER_CHANGE_NOTE,
  TIER_LABELS,
  TIER_SUMMARIES,
  tierWarning,
} from './tier-copy'

export function CreateProjectForm({
  onCancel,
  onCreated,
}: {
  onCancel?: () => void
  // Called on a successful create, before navigation. The sidebar modal lives
  // on the shell layout route, which navigating between projects does not
  // unmount — so closing it is an explicit act, not a side effect of the URL
  // change.
  onCreated?: () => void
}) {
  const navigate = useNavigate()
  const health = useHealth()
  const create = useCreateProject()

  const [name, setName] = useState('')
  const [directory, setDirectory] = useState('')
  // Whether the user has taken the directory field over. Until they do, the
  // suggestion tracks the name; after, it never overwrites what they typed.
  const [directoryEdited, setDirectoryEdited] = useState(false)
  const [createDirectory, setCreateDirectory] = useState(true)
  const [tier, setTier] = useState<ExecutionTier>('local')
  const [directoryError, setDirectoryError] = useState<string | null>(null)
  const [nameError, setNameError] = useState<string | null>(null)

  const suggestionRoot = projectsRoot(health.data)
  const suggestion = suggestProjectDirectory(suggestionRoot, name)
  const effectiveDirectory = directoryEdited || !suggestion ? directory : suggestion
  const sandboxUnavailable = health.data ? health.data.sandbox_available === false : false

  function onNameChange(value: string) {
    setName(value)
    if (nameError) setNameError(null)
  }

  function onDirectoryChange(value: string) {
    setDirectoryEdited(true)
    setDirectory(value)
    if (directoryError) setDirectoryError(null)
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    const trimmedName = name.trim()
    const checked = checkProjectDirectory(effectiveDirectory)

    // Both fields are reported at once: fixing one and resubmitting only to be
    // told about the other is the interaction this avoids.
    setNameError(trimmedName ? null : 'Give the project a name.')
    setDirectoryError(checked.ok ? null : checked.message)
    if (!trimmedName || !checked.ok) return

    create.mutate(
      {
        name: trimmedName,
        directory: checked.directory,
        tier,
        create_directory: createDirectory,
      },
      {
        onSuccess: (project) => {
          onCreated?.()
          navigate(projectSessionRoute(project.id))
        },
      },
    )
  }

  const submitError = create.error
    ? isApiError(create.error)
      ? create.error.message
      : 'The project could not be created.'
    : null

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-5">
      <TextField
        label="Name"
        value={name}
        onChange={(event) => onNameChange(event.target.value)}
        placeholder="My project"
        autoComplete="off"
        error={nameError}
      />

      <TextField
        label="Directory"
        value={effectiveDirectory}
        onChange={(event) => onDirectoryChange(event.target.value)}
        placeholder="/home/you/code/my-project"
        autoComplete="off"
        spellCheck={false}
        className="font-mono"
        error={directoryError}
        hint={SHARED_DIRECTORY_NOTE}
      />

      <CheckboxField
        label="Create this directory if it does not exist"
        checked={createDirectory}
        onChange={(event) => setCreateDirectory(event.target.checked)}
        hint={
          suggestionRoot
            ? `Left blank, new projects are created under ${suggestionRoot}.`
            : undefined
        }
      />

      <fieldset className="flex flex-col gap-2">
        <legend className="pb-1.5 text-xs font-medium text-ink-2">Execution tier</legend>
        <div className="flex flex-col gap-2">
          {EXECUTION_TIERS.map((candidate) => (
            <label
              key={candidate}
              className={cn(
                'flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2.5',
                candidate === tier
                  ? 'border-accent bg-accent-soft'
                  : 'border-border hover:bg-surface-2',
              )}
            >
              <input
                type="radio"
                name="tier"
                value={candidate}
                checked={candidate === tier}
                onChange={() => setTier(candidate)}
                className="mt-0.5 size-3.5 accent-[var(--accent)]"
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-medium text-ink">{TIER_LABELS[candidate]}</span>
                <span className="text-xs leading-relaxed text-ink-3">
                  {TIER_SUMMARIES[candidate]}
                </span>
              </span>
            </label>
          ))}
        </div>

        {/* The safety statement, rendered for whichever tier is selected. For
            `local` this is the product saying plainly what it may do to the
            user's machine; it is an acceptance criterion, not decoration. */}
        <Callout tone={tier === 'local' ? 'warn' : 'info'}>{tierWarning(tier)}</Callout>
        {tier === 'sandbox' && sandboxUnavailable ? (
          <Callout tone="warn">{SANDBOX_UNAVAILABLE_NOTE}</Callout>
        ) : null}
        <p className="text-xs leading-relaxed text-ink-3">{TIER_CHANGE_NOTE}</p>
      </fieldset>

      {submitError ? <Callout tone="danger">{submitError}</Callout> : null}

      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" disabled={create.isPending}>
          {create.isPending ? 'Creating…' : 'Create project'}
        </Button>
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  )
}
