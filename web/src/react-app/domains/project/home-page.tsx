/**
 * The `/` landing surface: the project picker, and the place projects are made.
 *
 * Deliberately not a redirect to the last-open session. A cold start lands
 * here and lets the user choose; restoring whatever was open last time makes a
 * fresh boot and a bookmark disagree about what the address bar means, and the
 * URL is the authority (D9).
 *
 * Creating a project is a *surface* rather than a modal, for the same reason:
 * it has an address, so it survives a refresh and can be linked to. On a first
 * run the form is already open, because with no projects there is nothing else
 * to do here.
 */

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { projectSessionRoute } from '@/app/routes'
import { Button, Card, CardDescription, CardTitle, CenteredNote } from '@/react-app/design-system'
import { CreateProjectForm } from './create-project-form'
import { Callout } from './form-controls'
import { useProjectIndex } from './project-index'
import { TIER_LABELS } from './tier-copy'

export function HomePage() {
  const { status, projects, error } = useProjectIndex()
  const [creating, setCreating] = useState(false)

  if (status === 'loading') return <CenteredNote>Loading projects…</CenteredNote>

  const empty = projects.length === 0
  const showForm = creating || empty

  return (
    <div className="mx-auto w-full max-w-2xl px-8 py-10">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-ink">Projects</h1>
          <p className="mt-1 max-w-prose text-sm leading-relaxed text-ink-2">
            A project is one directory on this machine plus the sessions held against it.
          </p>
        </div>
        {!empty ? (
          <Button variant={creating ? 'ghost' : 'outline'} onClick={() => setCreating(!creating)}>
            {creating ? 'Cancel' : 'New project'}
          </Button>
        ) : null}
      </header>

      {error ? (
        <div className="mt-6">
          <Callout tone="danger">The project list could not be loaded. {error.message}</Callout>
        </div>
      ) : null}

      {!empty ? (
        <ul className="mt-6 flex flex-col gap-2">
          {projects.map((project) => (
            <li key={project.id}>
              <Link
                to={projectSessionRoute(project.id)}
                className="block rounded-lg border border-border bg-surface px-4 py-3 hover:border-border-strong hover:bg-surface-2"
              >
                <span className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-sm font-medium text-ink">{project.name}</span>
                  <span className="shrink-0 text-[11px] text-ink-3">
                    {TIER_LABELS[project.tier]}
                  </span>
                </span>
                <span className="mt-0.5 block truncate font-mono text-xs text-ink-3">
                  {project.directory}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}

      {showForm ? (
        <Card className="mt-6">
          <CardTitle>{empty ? 'Create your first project' : 'New project'}</CardTitle>
          <CardDescription>
            Point it at a directory you already work in, or let the workbench create one.
          </CardDescription>
          <div className="mt-5">
            <CreateProjectForm
              onCreated={() => setCreating(false)}
              onCancel={empty ? undefined : () => setCreating(false)}
            />
          </div>
        </Card>
      ) : null}
    </div>
  )
}
