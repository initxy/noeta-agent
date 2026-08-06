import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import type { Project } from '@/app/types'
import { CommandPalette } from './command-palette'

/**
 * The palette's behaviour, through the real `cmdk`.
 *
 * The file is mostly one property: **Escape goes back before it closes.** It
 * is asserted from a sub-view, from the root view, and through the Backspace
 * path that the hand reaches for first — because the bug it prevents (losing
 * both the view and the query to a keystroke meant as "undo that step") is
 * only visible from inside a sub-view.
 *
 * The second property is the IME guard: an Enter that commits a Chinese or
 * Japanese candidate must not run the highlighted command. `cmdk` guards two
 * of the three composition signals itself; this file pins that the palette
 * guards all three.
 */

const PROJECTS: Project[] = [
  {
    id: 'p1',
    name: 'Alpha',
    directory: '/tmp/alpha',
    tier: 'local',
    default_model: null,
    default_effort: null,
    persona: null,
    memory_enabled: false,
  },
  {
    id: 'p2',
    name: 'Beta',
    directory: '/tmp/beta',
    tier: 'sandbox',
    default_model: null,
    default_effort: null,
    persona: null,
    memory_enabled: false,
  },
]

vi.mock('@/react-app/domains/project/project-index', () => ({
  useProjectIndex: () => ({
    status: 'ready',
    projects: PROJECTS,
    fallbackProjectId: null,
    error: null,
  }),
}))

vi.mock('@/react-app/domains/session/session-index', () => ({
  useSessionIndex: () => ({
    status: 'ready',
    sessions: [
      { id: 's1', title: 'Fix the login bug', parentSessionId: null, branchedAtSeq: null },
      { id: 's2', title: 'Draft release notes', parentSessionId: null, branchedAtSeq: null },
    ],
  }),
}))

const createSession = vi.fn()
vi.mock('@/react-app/domains/session/queries/session-queries', () => ({
  useCreateSession: () => ({ mutate: createSession, isPending: false, error: null }),
}))

function Probe() {
  return <span data-testid="path">{useLocation().pathname}</span>
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        {/* The shell mounts the palette in a pathless layout route, which is
            what makes `useParams` see the child route's ids. */}
        <Route
          element={
            <>
              <CommandPalette />
              <Probe />
              <Outlet />
            </>
          }
        >
          <Route path="/project/:projectId/session/:sessionId" element={null} />
          <Route path="/project/:projectId/session" element={null} />
          <Route path="*" element={null} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

const path = () => screen.getByTestId('path').textContent
const input = () => screen.getByPlaceholderText(/Search/)
const openPalette = () => fireEvent.keyDown(window, { key: 'k', ctrlKey: true })

beforeEach(() => {
  createSession.mockReset()
  // jsdom ships neither, and `cmdk` uses both to keep the highlighted row in view.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('opening and closing', () => {
  it('toggles on the command modifier', () => {
    renderAt('/project/p1/session/s1')
    expect(screen.queryByPlaceholderText('Search actions…')).toBeNull()

    openPalette()
    expect(screen.getByPlaceholderText('Search actions…')).toBeTruthy()

    openPalette()
    expect(screen.queryByPlaceholderText('Search actions…')).toBeNull()
  })

  it('opens straight into the shortcuts view on its own binding', () => {
    renderAt('/project/p1/session/s1')
    fireEvent.keyDown(window, { key: '/', ctrlKey: true })

    expect(screen.getByPlaceholderText('Search shortcuts…')).toBeTruthy()
    expect(screen.getByText('Open or close the command palette')).toBeTruthy()
  })

  it('reopens on the root view rather than where it was left', () => {
    renderAt('/project/p1/session/s1')
    openPalette()
    fireEvent.click(screen.getByText('Go to session…'))
    expect(screen.getByPlaceholderText('Search sessions…')).toBeTruthy()

    openPalette()
    openPalette()
    expect(screen.getByPlaceholderText('Search actions…')).toBeTruthy()
  })
})

describe('Escape goes back before it closes', () => {
  it('steps out of a sub-view without closing, then closes from the root', () => {
    renderAt('/project/p1/session/s1')
    openPalette()

    fireEvent.click(screen.getByText('Go to session…'))
    expect(screen.getByPlaceholderText('Search sessions…')).toBeTruthy()

    fireEvent.keyDown(input(), { key: 'Escape' })
    // Still open — this is the whole point. One Escape undoes one step.
    expect(screen.getByPlaceholderText('Search actions…')).toBeTruthy()

    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(screen.queryByPlaceholderText('Search actions…')).toBeNull()
  })

  it('drops the query it was typed with when it steps back', () => {
    renderAt('/project/p1/session/s1')
    openPalette()
    fireEvent.click(screen.getByText('Go to session…'))

    fireEvent.change(input(), { target: { value: 'release' } })
    expect((input() as HTMLInputElement).value).toBe('release')

    fireEvent.keyDown(input(), { key: 'Escape' })
    expect((input() as HTMLInputElement).value).toBe('')
  })

  it('goes back on Backspace only when the box is empty', () => {
    renderAt('/project/p1/session/s1')
    openPalette()
    fireEvent.click(screen.getByText('Go to session…'))

    fireEvent.change(input(), { target: { value: 'x' } })
    fireEvent.keyDown(input(), { key: 'Backspace' })
    // Still in the sub-view: Backspace over text is just Backspace.
    expect(screen.getByPlaceholderText('Search sessions…')).toBeTruthy()

    fireEvent.change(input(), { target: { value: '' } })
    fireEvent.keyDown(input(), { key: 'Backspace' })
    expect(screen.getByPlaceholderText('Search actions…')).toBeTruthy()
  })

  it('leaves Backspace alone on the root view', () => {
    renderAt('/project/p1/session/s1')
    openPalette()

    fireEvent.keyDown(input(), { key: 'Backspace' })
    expect(screen.getByPlaceholderText('Search actions…')).toBeTruthy()
  })

  it('offers the same step back as a button while a sub-view is open', () => {
    renderAt('/project/p1/session/s1')
    openPalette()
    fireEvent.click(screen.getByText('Go to session…'))

    fireEvent.click(screen.getByText('Back'))
    expect(screen.getByPlaceholderText('Search actions…')).toBeTruthy()
  })
})

describe('the IME guard', () => {
  it('does not run the highlighted command on a candidate confirmation', () => {
    renderAt('/project/p1/session/s1')
    openPalette()
    fireEvent.click(screen.getByText('Go to session…'))

    for (const signal of [{ isComposing: true }, { keyCode: 229 }]) {
      fireEvent.keyDown(input(), { key: 'Enter', ...signal })
    }
    // And the signal `cmdk` does not know about: some engines report the
    // candidate confirmation as the `"Process"` key rather than as Enter.
    fireEvent.keyDown(input(), { key: 'Process' })

    expect(path()).toBe('/project/p1/session/s1')
    expect(screen.getByPlaceholderText('Search sessions…')).toBeTruthy()

    // The positive control, so the assertions above cannot pass by the palette
    // simply being deaf to Enter.
    fireEvent.change(input(), { target: { value: 'release' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(path()).toBe('/project/p1/session/s2')
  })
})

describe('commands', () => {
  it('navigates to the session it was told to open, and closes first', () => {
    renderAt('/project/p1/session/s1')
    openPalette()
    fireEvent.click(screen.getByText('Go to session…'))
    fireEvent.click(screen.getByText('Draft release notes'))

    expect(path()).toBe('/project/p1/session/s2')
    expect(screen.queryByPlaceholderText('Search sessions…')).toBeNull()
  })

  it('switches project through the project view', () => {
    renderAt('/project/p1/session/s1')
    openPalette()
    fireEvent.click(screen.getByText('Switch project…'))
    fireEvent.click(screen.getByText('Beta'))

    expect(path()).toBe('/project/p2/session')
  })

  it('creates a session in the project the URL names', () => {
    renderAt('/project/p1/session/s1')
    openPalette()
    fireEvent.click(screen.getByText('New session'))

    expect(createSession).toHaveBeenCalledTimes(1)
    expect(createSession.mock.calls[0][0]).toEqual({ projectId: 'p1' })
  })

  it('hides the project-scoped commands when no project is open', () => {
    renderAt('/')
    openPalette()

    expect(screen.queryByText('New session')).toBeNull()
    expect(screen.queryByText('Go to session…')).toBeNull()
    expect(screen.getByText('Switch project…')).toBeTruthy()
  })

  it('offers the trace only for a session that exists in the URL', () => {
    renderAt('/project/p1/session')
    openPalette()
    expect(screen.queryByText('Open the trace for this session')).toBeNull()

    cleanup()
    renderAt('/project/p1/session/s1')
    openPalette()
    fireEvent.click(screen.getByText('Open the trace for this session'))
    expect(path()).toBe('/trace/s1')
  })
})
