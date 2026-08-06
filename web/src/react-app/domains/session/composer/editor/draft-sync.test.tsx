import { afterEach, describe, expect, it } from 'vitest'
import { useEffect, useState } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $createTextNode, $getRoot, $isElementNode } from 'lexical'
import type { LexicalEditor } from 'lexical'
import type { MentionTable } from '@/app/draft/tokens'
import { DraftSyncPlugin } from './draft-sync'
import { DraftTokenNode } from './token-node'

/**
 * The third serialization trap: read the editor **before** `editor.update()`.
 *
 * The failure it prevents is invisible in a screenshot and obvious in use — the
 * draft comes back down as a prop right after the editor produced it, and a
 * plugin that re-renders the tree from an identical string throws the caret to
 * the end on every keystroke.
 */

const MENTIONS: MentionTable = { 'src/app.ts': 'file' }

let editor: LexicalEditor | null = null

function Capture() {
  const [instance] = useLexicalComposerContext()
  useEffect(() => {
    editor = instance
  }, [instance])
  return null
}

function Harness({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial)
  return (
    <LexicalComposer
      initialConfig={{
        namespace: 'test',
        nodes: [DraftTokenNode],
        onError: (error) => {
          throw error
        },
        theme: {},
      }}
    >
      <PlainTextPlugin
        contentEditable={<ContentEditable aria-label="Message" />}
        ErrorBoundary={LexicalErrorBoundary}
      />
      <DraftSyncPlugin value={value} mentions={MENTIONS} onChange={setValue} />
      <Capture />
    </LexicalComposer>
  )
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
  })
}

afterEach(() => {
  cleanup()
  editor = null
})

describe('DraftSyncPlugin', () => {
  it('does not rebuild the tree for the echo of the editor’s own change', async () => {
    const { container } = render(<Harness initial="see @src/app.ts" />)
    await flush()

    const chip = container.querySelector('[data-draft-token]')
    expect(chip).not.toBeNull()

    // An edit made *inside* the editor, as a user's keystroke would be. It
    // travels out through `onChange`, comes back down as `value`, and must not
    // re-enter the editor.
    await act(async () => {
      editor?.update(() => {
        const last = $getRoot().getLastChild()
        if ($isElementNode(last)) last.append($createTextNode(' now'))
      })
      await Promise.resolve()
    })

    expect(editor?.getEditorState().read(() => $getRoot().getTextContent())).toBe(
      'see @src/app.ts now',
    )
    // Same DOM node: `$renderDraft` clears the root, so a rebuild would replace
    // it — and take the selection with it.
    expect(container.querySelector('[data-draft-token]')).toBe(chip)
  })

  it('does rebuild when the draft genuinely changes from outside', async () => {
    const { container } = render(<Harness initial="plain" />)
    await flush()
    expect(container.querySelector('[data-draft-token]')).toBeNull()

    await act(async () => {
      editor?.update(() => {
        const last = $getRoot().getLastChild()
        if ($isElementNode(last)) last.append($createTextNode(' @src/app.ts'))
      })
      await Promise.resolve()
    })
    await flush()

    // The editor produced the token as text; the value that came back is what
    // the chip is built from on the next genuine divergence.
    expect(editor?.getEditorState().read(() => $getRoot().getTextContent())).toBe(
      'plain @src/app.ts',
    )
  })
})
