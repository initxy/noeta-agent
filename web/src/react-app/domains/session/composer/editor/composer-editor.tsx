/**
 * The composer's editor: a Lexical surface over a plain-string draft.
 *
 * **Controlled, and the string is the state.** `value` in, `onChange` out; the
 * node tree is a view that is rebuilt whenever the two disagree. Nothing above
 * this component knows Lexical exists, which is what lets a draft be persisted,
 * restored after a rejected send, and rendered by a panel that has no editor at
 * all.
 *
 * **The menus are functions of the draft.** `draftTrigger` is anchored to the
 * whole string, so "is a menu open" is derived, not remembered — it survives a
 * re-render, a session switch and a restored draft without any of them knowing.
 * That anchoring is also what makes committing a slash command a *whole-draft
 * replacement*, which cannot eat text because the trigger already established
 * there was none.
 *
 * **Keyboard is one capture-phase handler, not a stack of Lexical commands.**
 * Enter's meaning here is a composer decision (send / accept a menu row), not a
 * text-editing one, so it is decided in one place where the IME guard is
 * visible. `stopPropagation` in a capture handler on this wrapper is what keeps
 * the event away from Lexical's own Enter handling; Shift+Enter is deliberately
 * *not* stopped, so a newline is still Lexical's job.
 *
 * The IME guard is three signals — a composition ref, the native
 * `isComposing`, and `keyCode === 229` — because none of them is reliable
 * across engines, and getting it wrong sends half a word to the model every
 * time a CJK user types.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { commitMention, draftTrigger, slashCommandDraft } from '@/app/draft/triggers'
import { DraftSyncPlugin } from './draft-sync'
import { mentionActions, useMentionTable } from './mention-store'
import { SuggestionMenu } from './suggestion-menu'
import { DraftTokenNode } from './token-node'
import { rankSuggestions, useFileSuggestions, useSlashCommands } from './suggestions'
import type { Suggestion } from './suggestions'

/** How tall the editor may grow before it scrolls instead. */
const MAX_HEIGHT_PX = 200

export interface ComposerEditorProps {
  /** Which draft this is — the session id, or the new-session key. */
  draftKey: string
  /** Null on the surface that has no session yet; the file search needs one. */
  sessionId: string | null
  value: string
  onChange: (draft: string) => void
  onSubmit: () => void
  /**
   * Whether a suggestion menu is open. The composer needs it because Escape is
   * decided outermost-first: without this it would arm a stop behind a menu the
   * user is dismissing.
   */
  onMenuOpenChange: (open: boolean) => void
  placeholder: string
}

export function ComposerEditor({
  draftKey,
  sessionId,
  value,
  onChange,
  onSubmit,
  onMenuOpenChange,
  placeholder,
}: ComposerEditorProps) {
  const mentions = useMentionTable(draftKey)
  const composingRef = useRef(false)
  const [activeIndex, setActiveIndex] = useState(0)
  /**
   * The draft the menu was last dismissed on. Escape closes the menu until the
   * draft changes — which is the only signal that could change the answer, and
   * it keeps "dismissed" from being a second piece of state to reset.
   */
  const [dismissedAt, setDismissedAt] = useState<string | null>(null)

  const trigger = draftTrigger(value)
  const active = trigger !== null && dismissedAt !== value ? trigger : null

  const commands = useSlashCommands(sessionId)
  const files = useFileSuggestions(
    sessionId,
    active?.kind === 'mention' ? active.query : '',
    active?.kind === 'mention',
  )

  const items: Suggestion[] =
    active === null
      ? []
      : active.kind === 'slash'
        ? rankSuggestions(active.query, commands)
        : (files.data ?? [])

  // The slash menu always renders a body; the mention menu renders nothing when
  // it has nothing (see suggestion-menu).
  const open = active !== null && (active.kind === 'slash' || items.length > 0)

  useEffect(() => {
    setActiveIndex(0)
  }, [active?.kind, active?.query])

  // A dismissal lasts as long as the trigger it dismissed. Without this,
  // pressing Escape on `/`, deleting it and typing `/` again lands on the same
  // draft string and the menu stays shut for no reason the user can see.
  const hasTrigger = trigger !== null
  useEffect(() => {
    if (!hasTrigger) setDismissedAt(null)
  }, [hasTrigger])

  useEffect(() => {
    onMenuOpenChange(open)
  }, [open, onMenuOpenChange])

  const accept = useCallback(
    (item: Suggestion) => {
      if (active === null) return
      if (active.kind === 'slash') {
        onChange(slashCommandDraft(item.id))
        return
      }
      mentionActions().remember(draftKey, item.id, 'file')
      onChange(commitMention(value, item.id))
    },
    [active, draftKey, onChange, value],
  )

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const composing =
      composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229
    const consume = () => {
      event.preventDefault()
      event.stopPropagation()
    }

    if (open && !composing) {
      if (event.key === 'Escape') {
        consume()
        setDismissedAt(value)
        return
      }
      if (items.length > 0) {
        if (event.key === 'ArrowDown') {
          consume()
          setActiveIndex((index) => (index + 1) % items.length)
          return
        }
        if (event.key === 'ArrowUp') {
          consume()
          setActiveIndex((index) => (index - 1 + items.length) % items.length)
          return
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          consume()
          accept(items[activeIndex] ?? items[0])
          return
        }
      }
    }

    if (event.key !== 'Enter') return
    if (composing) return
    // Not consumed: the newline is Lexical's to insert.
    if (event.shiftKey) return
    consume()
    onSubmit()
  }

  return (
    <div
      className="relative"
      onKeyDownCapture={handleKeyDown}
      onCompositionStart={() => {
        composingRef.current = true
      }}
      onCompositionEnd={() => {
        composingRef.current = false
      }}
    >
      <LexicalComposer
        initialConfig={{
          namespace: 'composer',
          nodes: [DraftTokenNode],
          // A malformed draft must never take the composer down with it: the
          // draft string is still intact in the store, so the recoverable move
          // is to log and keep typing.
          onError: (error) => {
            console.error('composer editor', error)
          },
          theme: {},
        }}
      >
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              aria-label="Message"
              aria-placeholder={placeholder}
              placeholder={
                <div className="pointer-events-none absolute inset-x-3 top-2 truncate text-sm text-ink-3">
                  {placeholder}
                </div>
              }
              style={{ maxHeight: `${MAX_HEIGHT_PX}px` }}
              // No border or background of its own: the composer card owns those
              // and lifts them on `focus-within`, so the editor is seamless
              // inside it rather than a bordered box within a bordered box.
              className="w-full overflow-y-auto bg-transparent px-3 pt-2.5 pb-1 text-sm leading-relaxed text-ink outline-none"
            />
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <DraftSyncPlugin value={value} mentions={mentions} onChange={onChange} />
      </LexicalComposer>

      {open ? (
        <SuggestionMenu
          label={active?.kind === 'slash' ? 'Commands' : 'Files'}
          items={items}
          activeIndex={activeIndex}
          emptyMessage={active?.kind === 'slash' ? 'No commands available.' : null}
          onHover={setActiveIndex}
          onSelect={accept}
        />
      ) : null}
    </div>
  )
}
