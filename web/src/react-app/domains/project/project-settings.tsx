/**
 * Project settings, one panel per tab.
 *
 * The split follows what a change *costs*, not what the API happens to group:
 *
 * - **General** — the identity of the project and the execution tier. The tier
 *   is here rather than beside the model because it is the one setting with a
 *   safety consequence, and because it is not retroactive: an existing session
 *   keeps the tier it was created with, so the control has to say so
 *   (`tier-copy.ts`).
 * - **Agent** — persona and the default model + effort, the settings that
 *   change what the next turn does.
 * - **Memory** — the recall toggle, alone, because turning it off is a
 *   privacy decision and does not belong in a list of preferences.
 * - **Advanced** — identity and deletion.
 *
 * All four write through `project-queries.ts` and let the query cache be the
 * source of truth: the forms hold a draft only while it differs from the
 * server, which is what stops a saved value from being overwritten by a stale
 * `useState` initialiser after an invalidation.
 */

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { HOME_ROUTE } from '@/app/routes'
import type { AgentConfig, ExecutionTier, Project } from '@/app/types'
import { Button, CenteredNote } from '@/react-app/design-system'
import { effortsFor, useModels } from '@/react-app/infra/models-query'
import { useHealth } from '@/react-app/infra/health-query'
import {
  Callout,
  CheckboxField,
  Field,
  SelectField,
  SettingsSection,
  TextAreaField,
  TextField,
} from './form-controls'
import {
  useAgentConfig,
  useDeleteProject,
  usePutAgentConfig,
  useUpdateProject,
} from './project-queries'
import { useProjectIndex } from './project-index'
import {
  EXECUTION_TIERS,
  SANDBOX_UNAVAILABLE_NOTE,
  SHARED_DIRECTORY_NOTE,
  TIER_CHANGE_NOTE,
  TIER_LABELS,
  TIER_SUMMARIES,
  tierWarning,
} from './tier-copy'

/**
 * The open project, from the index the sidebar already has.
 *
 * A separate detail query would be a second copy of the same row, invalidated
 * on a different schedule — and the two disagreeing is exactly what makes a
 * settings page show a name the sidebar has already changed.
 */
function useProject(projectId: string): Project | null {
  const { projects } = useProjectIndex()
  return projects.find((project) => project.id === projectId) ?? null
}

function SaveRow({
  dirty,
  pending,
  error,
  onSave,
  onReset,
}: {
  dirty: boolean
  pending: boolean
  error: Error | null
  onSave: () => void
  onReset: () => void
}) {
  return (
    <>
      <Button variant="primary" onClick={onSave} disabled={!dirty || pending}>
        {pending ? 'Saving…' : 'Save'}
      </Button>
      {dirty ? (
        <Button variant="ghost" onClick={onReset} disabled={pending}>
          Discard
        </Button>
      ) : null}
      {error ? <span className="text-xs text-danger">{error.message}</span> : null}
    </>
  )
}

// ---------------------------------------------------------------------------
// General
// ---------------------------------------------------------------------------

export function ProjectGeneralSettings({ projectId }: { projectId: string }) {
  const project = useProject(projectId)
  const update = useUpdateProject(projectId)
  const health = useHealth()

  const [name, setName] = useState('')
  const [tier, setTier] = useState<ExecutionTier>('local')
  const [seed, setSeed] = useState<string | null>(null)

  // Re-seed the draft from the server row whenever the row's *values* change,
  // adjusting state during render rather than in an effect: an effect would
  // paint the stale draft first, and a refetch returning identical data would
  // still stamp over what the user is typing.
  // `\u0000` is written as an escape, never as a literal NUL byte: one raw
  // NUL makes the whole file `binary` to grep and to `git diff`, which
  // silently drops it out of code review and out of every source search.
  const row = project ? [project.id, project.name, project.tier].join('\u0000') : null
  if (project && row !== seed) {
    setSeed(row)
    setName(project.name)
    setTier(project.tier)
  }

  if (!project) return <CenteredNote>Loading project…</CenteredNote>

  const dirty = name.trim() !== project.name || tier !== project.tier
  const sandboxUnavailable = health.data ? health.data.sandbox_available === false : false

  return (
    <div className="flex flex-col">
      <SettingsSection
        title="Project"
        description="The name is yours; the directory is the project's identity and cannot be moved from here."
        footer={
          <SaveRow
            dirty={dirty}
            pending={update.isPending}
            error={update.error}
            onSave={() => {
              if (!name.trim()) return
              update.mutate({ name: name.trim(), tier })
            }}
            onReset={() => {
              setName(project.name)
              setTier(project.tier)
            }}
          />
        }
      >
        <TextField
          label="Name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoComplete="off"
        />
        <Field label="Directory" hint={SHARED_DIRECTORY_NOTE}>
          <p className="rounded-md border border-border bg-surface-2 px-2.5 py-1.5 font-mono text-sm break-all text-ink-2">
            {project.directory}
          </p>
        </Field>
      </SettingsSection>

      <SettingsSection title="Execution tier" description={TIER_CHANGE_NOTE}>
        <div className="flex flex-col gap-2">
          {EXECUTION_TIERS.map((candidate) => (
            <label
              key={candidate}
              className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border px-3 py-2.5 hover:bg-surface-2"
            >
              <input
                type="radio"
                name="project-tier"
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
        <Callout tone={tier === 'local' ? 'warn' : 'info'}>{tierWarning(tier)}</Callout>
        {tier === 'sandbox' && sandboxUnavailable ? (
          <Callout tone="warn">{SANDBOX_UNAVAILABLE_NOTE}</Callout>
        ) : null}
      </SettingsSection>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

const EMPTY_CONFIG: AgentConfig = {
  persona: null,
  default_model: null,
  default_effort: null,
  memory_enabled: false,
}

/**
 * Persona, default model and default effort.
 *
 * The effort list is derived from the selected model, so changing model drops
 * an effort the new model does not offer — carrying it over would send the
 * backend a pair it answers with a 422 that the user cannot act on.
 */
export function ProjectAgentSettings({ projectId }: { projectId: string }) {
  const config = useAgentConfig(projectId)
  const save = usePutAgentConfig(projectId)
  const models = useModels()

  const [draft, setDraft] = useState<AgentConfig>(EMPTY_CONFIG)
  const [seed, setSeed] = useState<string | null>(null)
  const server = config.data

  // Same re-seed rule as General: track the server's values, not its object
  // identity, so a background refetch cannot discard an unsaved edit.
  const row = server ? JSON.stringify(server) : null
  if (server && row !== seed) {
    setSeed(row)
    setDraft(server)
  }

  if (config.isPending) return <CenteredNote>Loading agent configuration…</CenteredNote>
  if (config.error) {
    return (
      <div className="p-6">
        <Callout tone="danger">
          The agent configuration could not be loaded. {config.error.message}
        </Callout>
      </div>
    )
  }

  const current = server ?? EMPTY_CONFIG
  const dirty =
    (draft.persona ?? '') !== (current.persona ?? '') ||
    draft.default_model !== current.default_model ||
    draft.default_effort !== current.default_effort
  const catalog = models.data ?? []
  const efforts = effortsFor(catalog, draft.default_model)

  return (
    <div className="flex flex-col">
      <SettingsSection
        title="Persona"
        description="Prepended to the agent's instructions in every session of this project."
        footer={
          <SaveRow
            dirty={dirty}
            pending={save.isPending}
            error={save.error}
            onSave={() => save.mutate({ ...draft, memory_enabled: current.memory_enabled })}
            onReset={() => setDraft(current)}
          />
        }
      >
        <TextAreaField
          label="Persona"
          value={draft.persona ?? ''}
          placeholder="You are working on a Rust CLI. Prefer small, reviewable diffs."
          onChange={(event) =>
            setDraft({ ...draft, persona: event.target.value ? event.target.value : null })
          }
        />

        <SelectField
          label="Default model"
          value={draft.default_model ?? ''}
          hint={
            catalog.length === 0
              ? 'No models are configured. Sessions use the backend default.'
              : 'Used unless a turn picks another model.'
          }
          onChange={(event) => {
            const next = event.target.value || null
            // Efforts belong to a model; keeping the old one across a model
            // change sends a pair the backend rejects with a 422.
            setDraft({ ...draft, default_model: next, default_effort: null })
          }}
        >
          <option value="">Backend default</option>
          {catalog.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
        </SelectField>

        <SelectField
          label="Default effort"
          value={draft.default_effort ?? ''}
          disabled={efforts.length === 0}
          hint={
            efforts.length === 0
              ? 'Pick a model first — the effort ladder belongs to the model.'
              : undefined
          }
          onChange={(event) => setDraft({ ...draft, default_effort: event.target.value || null })}
        >
          <option value="">Model default</option>
          {efforts.map((effort) => (
            <option key={effort} value={effort}>
              {effort}
            </option>
          ))}
        </SelectField>
      </SettingsSection>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export function ProjectMemorySettings({ projectId }: { projectId: string }) {
  const config = useAgentConfig(projectId)
  const save = usePutAgentConfig(projectId)

  if (config.isPending) return <CenteredNote>Loading agent configuration…</CenteredNote>
  // No control while the load failed. The toggle writes the *whole* config
  // back, so offering it over a default-shaped placeholder would let one click
  // erase a persona and a default model that were only ever unreadable.
  if (!config.data) {
    return (
      <div className="p-6">
        <Callout tone="danger">
          The agent configuration could not be loaded, so memory cannot be changed from here.
          {config.error ? ` ${config.error.message}` : ''}
        </Callout>
      </div>
    )
  }
  const current = config.data

  return (
    <div className="flex flex-col">
      <SettingsSection
        title="Agent memory"
        description="Memory is scoped to this project. A session can write notes the project's later sessions recall; no other project can read them."
      >
        <CheckboxField
          label="Let the agent write and recall memories in this project"
          checked={current.memory_enabled}
          disabled={save.isPending}
          onChange={(event) => save.mutate({ ...current, memory_enabled: event.target.checked })}
          hint="Recalled notes appear in the conversation as a “recalled” chip, never as something you said."
        />
        {save.error ? <Callout tone="danger">{save.error.message}</Callout> : null}
      </SettingsSection>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Advanced
// ---------------------------------------------------------------------------

export function ProjectAdvancedSettings({ projectId }: { projectId: string }) {
  const project = useProject(projectId)
  const remove = useDeleteProject()
  const navigate = useNavigate()
  const [confirming, setConfirming] = useState(false)

  if (!project) return <CenteredNote>Loading project…</CenteredNote>

  return (
    <div className="flex flex-col">
      <SettingsSection title="Identity">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          <dt className="text-ink-3">Project id</dt>
          <dd className="font-mono break-all text-ink-2">{project.id}</dd>
          <dt className="text-ink-3">Directory</dt>
          <dd className="font-mono break-all text-ink-2">{project.directory}</dd>
          {project.created_at ? (
            <>
              <dt className="text-ink-3">Created</dt>
              <dd className="text-ink-2">{project.created_at}</dd>
            </>
          ) : null}
        </dl>
      </SettingsSection>

      <SettingsSection
        title="Delete project"
        description="Removes the project and its sessions from the workbench. The directory on disk is left exactly as it is."
        footer={
          confirming ? (
            <>
              <Button
                variant="danger"
                disabled={remove.isPending}
                onClick={() =>
                  remove.mutate(project.id, { onSuccess: () => navigate(HOME_ROUTE) })
                }
              >
                {remove.isPending ? 'Deleting…' : `Delete “${project.name}”`}
              </Button>
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={() => setConfirming(true)}>
              Delete project…
            </Button>
          )
        }
      >
        {remove.error ? <Callout tone="danger">{remove.error.message}</Callout> : null}
      </SettingsSection>
    </div>
  )
}
