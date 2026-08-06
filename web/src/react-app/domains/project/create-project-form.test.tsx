import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { CreateProjectForm } from './create-project-form'
import { LOCAL_TIER_WARNING, SANDBOX_TIER_NOTE, TIER_CHANGE_NOTE } from './tier-copy'

/**
 * Two properties of this form are acceptance criteria rather than polish:
 *
 * 1. **A relative directory never reaches the network.** The backend rejects
 *    it with a 422, but learning that after a round trip is the wrong shape
 *    for the product's very first form.
 * 2. **The local tier states what it does.** Running the agent unsandboxed
 *    with no approval prompt is a decision the product is only allowed to make
 *    because it says so at the moment the choice is offered. The assertion is
 *    on the shipped string, so rewording it is a visible change.
 */

const mutate = vi.fn()

vi.mock('./project-queries', () => ({
  useCreateProject: () => ({ mutate, isPending: false, error: null }),
}))

vi.mock('@/react-app/infra/health-query', () => ({
  useHealth: () => ({
    data: {
      status: 'ok',
      version: '0.5.1',
      provider: 'mock',
      sandbox_available: true,
      data_dir: '/tmp/data',
    },
  }),
  projectsRoot: () => '/tmp/data/projects',
}))

function renderForm() {
  return render(
    <MemoryRouter>
      <CreateProjectForm />
    </MemoryRouter>,
  )
}

const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Create project' }))
const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } })

beforeEach(() => {
  mutate.mockClear()
})

afterEach(() => {
  cleanup()
})

describe('the execution tier control', () => {
  it('states plainly what the local tier does, in the words that ship', () => {
    renderForm()

    expect(screen.getByText(LOCAL_TIER_WARNING)).toBeTruthy()
    // The three facts the string must never lose.
    expect(LOCAL_TIER_WARNING).toContain('no container isolation')
    expect(LOCAL_TIER_WARNING).toContain('no per-call approval')
    expect(LOCAL_TIER_WARNING).toContain('shell commands are not')
  })

  it('says the tier is not retroactive', () => {
    renderForm()

    expect(screen.getByText(TIER_CHANGE_NOTE)).toBeTruthy()
    expect(TIER_CHANGE_NOTE).toContain('new sessions only')
  })

  it('swaps the statement when the sandbox tier is chosen', () => {
    renderForm()
    fireEvent.click(screen.getByRole('radio', { name: /Sandbox/ }))

    expect(screen.queryByText(LOCAL_TIER_WARNING)).toBeNull()
    expect(screen.getByText(SANDBOX_TIER_NOTE)).toBeTruthy()
  })
})

describe('creating a project', () => {
  it('rejects a relative directory before the request is made', () => {
    renderForm()
    type('Name', 'Demo')
    type('Directory', 'code/demo')
    submit()

    expect(mutate).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('absolute path')
  })

  it('rejects a ~ path, which the backend does not expand', () => {
    renderForm()
    type('Name', 'Demo')
    type('Directory', '~/code/demo')
    submit()

    expect(mutate).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('~')
  })

  it('reports a missing name and a bad directory in one pass', () => {
    // Fixing one field only to be told about the other is the interaction
    // this avoids.
    renderForm()
    type('Directory', 'relative')
    submit()

    expect(screen.getAllByRole('alert')).toHaveLength(2)
    expect(mutate).not.toHaveBeenCalled()
  })

  it('sends the trimmed, normalised values once the directory is absolute', () => {
    renderForm()
    type('Name', '  Demo  ')
    type('Directory', '  /srv/demo/  ')
    submit()

    expect(mutate).toHaveBeenCalledTimes(1)
    expect(mutate.mock.calls[0][0]).toEqual({
      name: 'Demo',
      directory: '/srv/demo',
      tier: 'local',
      create_directory: true,
    })
  })

  it('suggests a directory under the backend projects root until the user takes over', () => {
    renderForm()
    type('Name', 'My App')

    expect(screen.getByLabelText('Directory')).toHaveProperty(
      'value',
      '/tmp/data/projects/my-app',
    )

    type('Directory', '/srv/elsewhere')
    type('Name', 'Renamed')
    // Once edited, the suggestion never overwrites what was typed.
    expect(screen.getByLabelText('Directory')).toHaveProperty('value', '/srv/elsewhere')
  })

  it('carries the chosen tier through to the request', () => {
    renderForm()
    type('Name', 'Demo')
    type('Directory', '/srv/demo')
    fireEvent.click(screen.getByRole('radio', { name: /Sandbox/ }))
    submit()

    expect(mutate.mock.calls[0][0]).toMatchObject({ tier: 'sandbox' })
  })

  it('closes the surface on success — the modal it may live in does not unmount on navigation', () => {
    // The sidebar modal sits on the shell layout route, which a project→project
    // navigation does not unmount; closing it is the form's job, not the URL's.
    const onCreated = vi.fn()
    // Drive the success path: the mutation invokes its onSuccess with the
    // created project.
    mutate.mockImplementation((_body, { onSuccess }) => onSuccess({ id: 'p-new' }))

    render(
      <MemoryRouter>
        <CreateProjectForm onCreated={onCreated} />
      </MemoryRouter>,
    )
    type('Name', 'Demo')
    type('Directory', '/srv/demo')
    submit()

    expect(onCreated).toHaveBeenCalledTimes(1)
  })
})
