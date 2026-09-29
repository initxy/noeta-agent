import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import type { RawUIEvent, WorkspaceFile } from '@/app/types'
import { createQueryClient } from '@/react-app/infra/query-client'
import { useConversationStore } from '../../state/conversation-store'
import { ComposerEditor } from './composer-editor'
import { useMentionStore } from './mention-store'

/**
 * The editor as the composer uses it: a controlled string in, a controlled
 * string out, with two menus that are functions of that string.
 *
 * Everything here is driven by **setting the draft**, never by typing into the
 * contentEditable — which is not a testing convenience but the property under
 * test. The triggers are anchored to the whole draft, so a menu's state is
 * derived from a string; if that ever stops being true, these tests stop being
 * able to open a menu at all.
 */

const FILES: WorkspaceFile[] = [
  { path: 'src/app.ts', size: 10, mtime: 0 },
  { path: 'src/composer.tsx', size: 10, mtime: 0 },
  { path: 'docs/notes.md', size: 10, mtime: 0 },
]

vi.mock('@/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/api')>()
  return { ...actual, listFiles: vi.fn(async () => FILES) }
})

const api = await import('@/app/api')
const listFiles = vi.mocked(api.listFiles)

const frame = (type: string, data: Record<string, unknown> = {}, seq: number | null = null) =>
  ({ seq, type, data }) as RawUIEvent

let changes: string[] = []
let submits = 0
let menuStates: boolean[] = []
let publish: ((draft: string) => void) | null = null

function Harness({ initial = '' }: { initial?: string }) {
  const [value, setValue] = useState(initial)
  publish = setValue
  return (
    <ComposerEditor
      draftKey="s1"
      sessionId="s1"
      value={value}
      onChange={(next) => {
        changes.push(next)
        setValue(next)
      }}
      onSubmit={() => {
        submits += 1
      }}
      onMenuOpenChange={(open) => menuStates.push(open)}
      placeholder="Send a message…"
    />
  )
}

async function flush() {
  // Lexical reconciles on a microtask; without this the tree is still empty.
  await act(async () => {
    await Promise.resolve()
  })
}

async function show(initial = '') {
  const view = render(
    <QueryClientProvider client={createQueryClient()}>
      <Harness initial={initial} />
    </QueryClientProvider>,
  )
  await flush()
  return view
}

const editor = () => screen.getByLabelText('Message')

/** Set the draft from outside — which is exactly what typing amounts to here. */
const setDraft = async (text: string) => {
  await act(async () => {
    publish?.(text)
    await Promise.resolve()
  })
}

beforeEach(() => {
  changes = []
  submits = 0
  menuStates = []
  listFiles.mockClear()
  useConversationStore.setState({ runtimes: {}, order: [] })
  useMentionStore.setState({ tables: {} })
})

afterEach(() => {
  cleanup()
})

describe('rendering a draft', () => {
  it('shows the placeholder on an empty draft, to the eye and to a reader', async () => {
    await show('')
    expect(screen.getByText('Send a message…')).toBeTruthy()
    expect(editor().getAttribute('aria-placeholder')).toBe('Send a message…')
  })

  it('renders a known mention as a chip and an unknown @word as text', async () => {
    useMentionStore.setState({ tables: { s1: { 'src/app.ts': 'file' } } })
    const { container } = await show('read @src/app.ts and @nobody')

    const chips = container.querySelectorAll('[data-draft-token]')
    expect(chips).toHaveLength(1)
    expect(chips[0].textContent).toBe('@src/app.ts')
    expect(editor().textContent).toContain('@nobody')
  })

  it('grows a chip when a mention becomes known', async () => {
    const { container } = await show('see @src/app.ts')
    expect(container.querySelector('[data-draft-token]')).toBeNull()

    // Committing a mention is what puts the value in the table; here the draft
    // arrives first, which is the restored-draft case.
    act(() => useMentionStore.getState().remember('s1', 'src/app.ts', 'file'))
    await setDraft('see @src/app.ts ')
    expect(container.querySelector('[data-draft-token]')?.textContent).toBe('@src/app.ts')
  })
})

describe('the slash menu', () => {
  it('opens on a draft that is nothing but the query', async () => {
    await show('/')
    expect(screen.getByRole('listbox', { name: 'Commands' })).toBeTruthy()
    // An empty catalogue is an answer, not a missing menu.
    expect(screen.getByText('No commands available.')).toBeTruthy()
  })

  it('stays shut on a mid-draft slash', async () => {
    await show('cd /usr')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('offers the skills this session has actually activated', async () => {
    act(() => {
      useConversationStore.getState().apply('s1', [frame('skill_activated', { skill: 'review' }, 1)])
    })
    await show('/rev')
    expect(screen.getByRole('option', { name: /review/ })).toBeTruthy()
  })

  it('replaces the WHOLE draft when a command is committed', async () => {
    act(() => {
      useConversationStore.getState().apply('s1', [frame('skill_activated', { skill: 'review' }, 1)])
    })
    await show('/rev')
    fireEvent.keyDown(editor(), { key: 'Enter' })

    expect(changes.at(-1)).toBe('/review ')
    // The Enter that accepted the row must not also send.
    expect(submits).toBe(0)
  })
})

describe('the mention menu', () => {
  it('opens at the end of the draft and lists workspace files', async () => {
    await show('read @src')
    await waitFor(() => expect(screen.getByRole('listbox', { name: 'Files' })).toBeTruthy())
    expect(screen.getByRole('option', { name: /src\/app\.ts/ })).toBeTruthy()
    expect(screen.queryByRole('option', { name: /docs\/notes\.md/ })).toBeNull()
  })

  it('stays shut on an email-looking @', async () => {
    await show('mail bob@example.com')
    await flush()
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(listFiles).not.toHaveBeenCalled()
  })

  it('replaces only the trailing @query, and remembers what the value was', async () => {
    await show('read @ap')
    await waitFor(() => expect(screen.getByRole('listbox', { name: 'Files' })).toBeTruthy())
    fireEvent.click(screen.getByRole('option', { name: /src\/app\.ts/ }))

    expect(changes.at(-1)).toBe('read @src/app.ts ')
    // Remembered, or the chip cannot render and the send cannot decode it.
    expect(useMentionStore.getState().tables.s1['src/app.ts']).toBe('file')
  })

  it('coalesces a burst of query changes into one extra request', async () => {
    await show('@')
    await waitFor(() => expect(listFiles).toHaveBeenCalledTimes(1))

    for (const draft of ['@s', '@sr', '@src']) await setDraft(draft)

    // Four distinct queries, two requests: the open, then the settled query.
    // Without the debounce this is one request per keystroke.
    await waitFor(() => expect(listFiles).toHaveBeenCalledTimes(2))
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(listFiles).toHaveBeenCalledTimes(2)
  })
})

describe('keyboard', () => {
  it('submits on Enter and on Cmd+Enter alike', async () => {
    await show('plan the week')
    fireEvent.keyDown(editor(), { key: 'Enter' })
    fireEvent.keyDown(editor(), { key: 'Enter', metaKey: true })
    expect(submits).toBe(2)
  })

  it('leaves Shift+Enter to the editor', async () => {
    await show('plan the week')
    fireEvent.keyDown(editor(), { key: 'Enter', shiftKey: true })
    expect(submits).toBe(0)
  })

  it('never submits the Enter that commits an IME composition', async () => {
    await show('你好')
    fireEvent.keyDown(editor(), { key: 'Enter', keyCode: 229 })
    fireEvent.keyDown(editor(), { key: 'Enter', isComposing: true })
    fireEvent.compositionStart(editor())
    fireEvent.keyDown(editor(), { key: 'Enter' })
    expect(submits).toBe(0)

    fireEvent.compositionEnd(editor())
    fireEvent.keyDown(editor(), { key: 'Enter' })
    expect(submits).toBe(1)
  })

  it('moves through the menu with the arrows, wrapping', async () => {
    await show('read @src')
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2))

    const selected = () =>
      screen.getAllByRole('option').findIndex((row) => row.getAttribute('aria-selected') === 'true')
    expect(selected()).toBe(0)
    fireEvent.keyDown(editor(), { key: 'ArrowDown' })
    expect(selected()).toBe(1)
    fireEvent.keyDown(editor(), { key: 'ArrowDown' })
    expect(selected()).toBe(0)
    fireEvent.keyDown(editor(), { key: 'ArrowUp' })
    expect(selected()).toBe(1)
  })

  it('closes the menu on Escape, and reopens on the next trigger', async () => {
    await show('/')
    expect(menuStates.at(-1)).toBe(true)

    fireEvent.keyDown(editor(), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
    expect(menuStates.at(-1)).toBe(false)

    // Deleting the `/` ends the episode; typing it again is a new question.
    await setDraft('')
    await setDraft('/')
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeNull())
  })
})
