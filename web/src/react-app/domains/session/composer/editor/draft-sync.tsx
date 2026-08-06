/**
 * Keeping the editor's node tree and the draft string in step, both ways.
 *
 * The **read before `editor.update()`** is the whole plugin, and it is the
 * third of the serialization traps. The draft comes back down as a prop
 * microseconds after the editor itself produced it, so the naive plugin
 * re-renders the tree from a string the tree already equals. An update that
 * changes nothing still resets the selection — which is exactly the caret jump
 * a multi-line paste produces in the reference. Reading the current
 * serialization *first* and returning makes the echo cost nothing at all
 * rather than costing the user their cursor.
 *
 * Its own module rather than a closure inside the editor because that read is
 * the thing worth pinning, and a plugin that cannot be mounted on its own
 * cannot be pinned at all.
 */

import { useEffect, useRef } from 'react'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import type { MentionTable } from '@/app/draft/tokens'
import { $renderDraft, $serializeDraft } from './draft-state'

export function DraftSyncPlugin({
  value,
  mentions,
  onChange,
}: {
  value: string
  mentions: MentionTable
  onChange: (draft: string) => void
}) {
  const [editor] = useLexicalComposerContext()
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  // A ref, because the table grows as a side effect of committing a mention and
  // the draft that needs it changes in the same tick: re-running this effect on
  // the table alone would re-render the tree for a fact it already has.
  const mentionsRef = useRef(mentions)
  mentionsRef.current = mentions
  /** The last string this plugin knows both sides agreed on. */
  const lastRef = useRef<string | null>(null)

  useEffect(
    () =>
      editor.registerUpdateListener(({ editorState }) => {
        const text = editorState.read($serializeDraft)
        if (text === lastRef.current) return
        lastRef.current = text
        onChangeRef.current(text)
      }),
    [editor],
  )

  useEffect(() => {
    const current = editor.getEditorState().read($serializeDraft)
    if (current === value) return
    lastRef.current = value
    editor.update(() => {
      $renderDraft(value, mentionsRef.current)
    })
  }, [editor, value])

  return null
}
