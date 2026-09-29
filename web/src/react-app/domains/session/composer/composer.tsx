/**
 * The composer.
 *
 * A Lexical editor over a plain-string draft, a model/effort pair, and the
 * send-state machine in `state/send-state.ts` wired to three verbs: run, steer,
 * stop. The draft is **one plain string** in a store keyed by session and
 * `deliver` is the single send path everything above it funnels into;
 * attachments, pasted-text chips and draft persistence attach to the same two
 * seams.
 *
 * What the editor adds here is one step, taken once, on the way out:
 * `resolveDraft` turns the token string into the two fields the wire takes —
 * the goal, and the skills a leading `/command` pins for the turn. It is also
 * what the send-state machine is asked about, so a draft that is *only* a
 * command has nothing to send and says so by staying disabled.
 *
 * Four behaviours are load-bearing:
 *
 * 1. **Steer is literally the idle send path.** A message sent into a running
 *    turn is an ordinary `POST /messages`; there is no steer endpoint and no
 *    second code path. `steering` exists only to freeze the model and effort
 *    pickers so the in-flight run's model cannot be swapped underneath it.
 *    Two paths would drift, and the way they drift is that one of them stops
 *    handling a rejection.
 * 2. **Two presses of Escape stop a turn, one never does.** The first arms for
 *    3000 ms and says so; the second interrupts. A single Escape reaching an
 *    abort is how people lose a turn's work to a keystroke meant to dismiss
 *    something. While the editor's suggestion menu is open Escape belongs to
 *    the menu — this handler sees it before the editor does and steps over it.
 * 3. **Enter belongs to the editor.** Send / accept-a-suggestion is one
 *    decision made in one place, with the triple IME guard beside it; this
 *    component only receives the intent. Two Enter handlers is how a menu
 *    selection also sends a message.
 * 4. **A rejected send gives the text back.** The optimistic bubble is removed
 *    and the draft is restored, because a 409 or a 422 means the turn was never
 *    seeded and the user's words are the only thing that was lost.
 *
 * The first message of a project also creates the session: a session with zero
 * task streams is the backend's own model of "new", so the product has a
 * usable first turn without a separate new-session ritual.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ClipboardEvent as ReactClipboardEvent,
  KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { useNavigate } from 'react-router-dom'
import { interruptSession, isApiError } from '@/app/api'
import { resolveDraft } from '@/app/draft/send'
import type { ResolvedDraft } from '@/app/draft/send'
import { intakeImageFile, toImageAttachments } from '@/app/images'
import type { LocalImage } from '@/app/images'
import { projectSessionRoute } from '@/app/routes'
import { useModels } from '@/react-app/infra/models-query'
import { useCreateSession, useSendMessage } from '../queries/session-queries'
import {
  composerActions,
  draftKey,
  useComposerImages,
  useDraft,
  useModelChoice,
  usePastedParts,
  useSteering,
} from '../state/composer-store'
import { conversationActions, useSessionRuntime } from '../state/conversation-store'
import { resolveSelection } from '../state/model-selection'
import { sendState } from '../state/send-state'
import { AttachmentStrip } from './attachment-strip'
import { useDraftPersistence } from './drafts'
import { ComposerEditor } from './editor/composer-editor'
import { useMentionTable } from './editor/mention-store'
import { appendHistory, useHistoryRecall } from './history'
import { ModelControls } from './model-controls'
import { appendLinks, handleComposerPaste, appendPastedTextToken, resolvePastedText } from './paste'
import type { PastedTextPart } from './paste'
import { SendControls } from './send-controls'

/** How long the first Escape stays armed before it lapses. */
const ESCAPE_ARM_MS = 3000

/**
 * How tall the editor grows before it scrolls — and therefore the height a
 * paste is measured against, since "too big for the box" is a rendered-size
 * question, not a character count. Mirrors `ComposerEditor`'s own cap.
 */
const MAX_EDITOR_HEIGHT_PX = 200

/** Why a file was not attached, in the words the user needs. */
const REFUSAL = {
  type: 'not an image',
  size: 'too large',
  missing: 'could not be read',
} as const

function errorMessage(error: unknown): string {
  if (isApiError(error)) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}

export function Composer({
  projectId,
  sessionId,
}: {
  projectId: string
  /** Null on the "project open, nothing selected" surface: sending creates one. */
  sessionId: string | null
}) {
  const key = draftKey(sessionId)
  useDraftPersistence(key)
  const draft = useDraft(key)
  const mentions = useMentionTable(key)
  const pastes = usePastedParts(key)
  const images = useComposerImages(key)
  const choice = useModelChoice(key)
  const steering = useSteering(key)
  const runtime = useSessionRuntime(sessionId)
  const models = useModels()
  const recall = useHistoryRecall()
  const selection = resolveSelection(models.data ?? [], choice)
  // The machine is asked about the *goal*, not about the characters in the box:
  // a draft that is only `/review` has a skill to pin and nothing to say, and
  // offering to send it would be offering an empty turn.
  const resolved = resolveDraft(draft, mentions)
  const state = sendState({
    conversation: runtime.conversation,
    sending: runtime.sending,
    draft: resolved.text,
    steering,
  })

  const createSession = useCreateSession()
  const sendMessage = useSendMessage()
  const navigate = useNavigate()
  const [failure, setFailure] = useState<string | null>(null)
  const [suggestionsOpen, setSuggestionsOpen] = useState(false)
  const [escapeArmed, setEscapeArmed] = useState(false)

  const escapeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // The selection is read inside async callbacks that outlive the render they
  // were created in; a ref keeps them from sending a model the user has since
  // changed away from.
  const selectionRef = useRef(selection)
  selectionRef.current = selection

  // Read inside async send callbacks that outlive the render they were created
  // in; the table only ever grows, so a ref is the whole story.
  const mentionsRef = useRef(mentions)
  mentionsRef.current = mentions

  const disarmEscape = useCallback(() => {
    if (escapeTimerRef.current !== null) clearTimeout(escapeTimerRef.current)
    escapeTimerRef.current = null
    setEscapeArmed(false)
  }, [])

  useEffect(() => () => disarmEscape(), [disarmEscape])

  /**
   * Post one message, showing it before the server has acknowledged it.
   *
   * The optimistic bubble goes in before the request: the durable
   * `user_message` frame replaces it in place, so the message never appears to
   * jump, and `sending` covers the seconds `seed_start` spends allocating a
   * container with no stream yet to report on it. On a rejection both are
   * withdrawn — the turn was never seeded.
   *
   * It takes a **resolved** draft rather than a raw one so the bubble shows the
   * same goal the server will echo back as `user_message` — a bubble showing
   * `/review look at this` that repaints as `look at this` reads as the product
   * editing what the user said.
   */
  // Read inside async callbacks that outlive the render that created them, for
  // the same reason as the selection.
  const pastesRef = useRef(pastes)
  pastesRef.current = pastes

  /** The draft as the wire takes it: pastes expanded, mentions decoded, skills split off. */
  const resolveForSend = useCallback(
    (raw: string): ResolvedDraft =>
      resolveDraft(resolvePastedText(raw, pastesRef.current), mentionsRef.current),
    [],
  )

  const postMessage = sendMessage.mutateAsync
  const deliver = useCallback(
    async (
      targetId: string,
      message: ResolvedDraft,
      attachments: readonly LocalImage[] = [],
    ): Promise<boolean> => {
      const conversation = conversationActions()
      conversation.markSending(targetId)
      const pendingKey = conversation.appendPending(targetId, message.text)
      try {
        await postMessage({
          projectId,
          sessionId: targetId,
          body: {
            text: message.text,
            model: selectionRef.current.model?.id,
            effort: selectionRef.current.effort ?? undefined,
            // Omitted rather than sent empty: `activations=()` keeps the seed
            // byte-identical to the no-skill path, and an empty array is a
            // needless difference between the two.
            skills: message.skills.length > 0 ? message.skills : undefined,
            images: attachments.length > 0 ? toImageAttachments(attachments) : undefined,
            // No task id: a session owns exactly one stream now (a fork is its
            // own session), so an untagged send lands on it unambiguously.
          },
        })
        return true
      } catch (error) {
        conversation.dropPending(targetId, pendingKey)
        conversation.clearSending(targetId)
        setFailure(errorMessage(error))
        return false
      }
    },
    [projectId, postMessage],
  )

  /** Run or steer — the same path, differing only in what it froze first. */
  const send = async (steer: boolean) => {
    // The raw draft is what comes back on a rejection: giving back the resolved
    // goal would silently drop the command and the chips with it.
    const raw = draft
    const message = resolveForSend(raw)
    const attachments = images
    const composer = composerActions()
    setFailure(null)

    let targetId = sessionId
    if (targetId === null) {
      try {
        targetId = (await createSession.mutateAsync({ projectId })).id
      } catch (error) {
        setFailure(errorMessage(error))
        return
      }
    }

    composer.clearDraft(key)
    composer.clearImages(key)
    if (steer) composer.setSteering(key, true)
    if (targetId !== sessionId) navigate(projectSessionRoute(projectId, targetId))

    if (await deliver(targetId, message, attachments)) {
      // After the accept, never before: a rejected send puts the words back in
      // the box, and having them one ↑ away as well is a duplicate the user has
      // to delete.
      appendHistory(raw)
    } else {
      composer.setDraft(draftKey(targetId), raw)
      composer.addImages(draftKey(targetId), attachments)
    }
  }

  /**
   * What Enter and the buttons agree on: run when idle, steer when busy.
   */
  const submit = () => {
    if (state.mode === 'idle') {
      if (state.canRun) void send(false)
      return
    }
    if (state.canSteer) void send(true)
  }

  const stop = () => {
    if (sessionId === null) return
    setFailure(null)
    void interruptSession(sessionId).catch((error) => {
      // Nothing had started yet — saying "no task stream" would be noise.
      if (isApiError(error) && error.code === 'no_task_stream') return
      setFailure(errorMessage(error))
    })
  }

  // A steer is over when the turn it joined is over. Also clears a flag left
  // behind by a session switch, so a background session cannot freeze the
  // pickers on a surface that is idle.
  useEffect(() => {
    if (state.mode === 'idle' && steering) composerActions().setSteering(key, false)
  }, [state.mode, steering, key])

  // The armed window lapses with the turn: an Escape armed against a run that
  // has already finished would stop the *next* one.
  useEffect(() => {
    if (state.mode === 'idle' && escapeArmed) disarmEscape()
  }, [state.mode, escapeArmed, disarmEscape])

  /**
   * Paste: files attach, a `text/uri-list` becomes links, a paste too big for
   * the box collapses to a chip, and ordinary text is left entirely alone.
   *
   * The last branch is the load-bearing one — not prevented, not re-inserted,
   * not normalized. The browser puts the characters at the caret, which is the
   * one implementation that cannot get the caret wrong.
   */
  const onPaste = (event: ReactClipboardEvent<HTMLDivElement>) => {
    const composer = composerActions()
    const editor = event.currentTarget.querySelector<HTMLElement>('[contenteditable="true"]')
    handleComposerPaste(event, { editor, maxHeightPx: MAX_EDITOR_HEIGHT_PX }, {
      attach: (files) => {
        void Promise.all(files.map((file) => intakeImageFile(file))).then((results) => {
          const accepted: LocalImage[] = []
          const refused: string[] = []
          for (const result of results) {
            if (result.ok) accepted.push(result.image)
            else refused.push(`${result.filename || 'file'} (${REFUSAL[result.reason]})`)
          }
          composer.addImages(key, accepted)
          // Named, not counted: "1 file was not attached" leaves the user
          // guessing which one and why.
          setFailure(refused.length === 0 ? null : `Not attached: ${refused.join(', ')}`)
        })
      },
      links: (links) => composer.setDraft(key, appendLinks(draft, links)),
      collapse: (part: PastedTextPart) => {
        composer.rememberPaste(key, part)
        composer.setDraft(key, appendPastedTextToken(draft, part.label))
      },
    })
  }

  /**
   * ↑ / ↓ recall, only on an unedited composer.
   *
   * `null` from the machine means "this keystroke is not a recall" and the
   * event is left alone, so the caret still moves through a multi-line draft.
   */
  const handleRecall = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    if (suggestionsOpen) return
    const next = event.key === 'ArrowUp' ? recall.back(draft) : recall.forward(draft)
    if (next === null) return
    event.preventDefault()
    event.stopPropagation()
    composerActions().setDraft(key, next)
  }

  /**
   * Escape, on the whole composer rather than the input, so it reaches the
   * turn from the buttons too.
   *
   * The order is the rule: the editor's suggestion menu owns Escape outright.
   * This handler runs *before* the editor's own — React dispatches capture
   * handlers outermost-first — so a suggestion menu is left to close itself
   * here rather than being closed twice.
   */
  const handleEscape = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return
    if (suggestionsOpen) return
    if (!state.canStop) return
    event.preventDefault()
    if (escapeArmed) {
      disarmEscape()
      stop()
      return
    }
    setEscapeArmed(true)
    if (escapeTimerRef.current !== null) clearTimeout(escapeTimerRef.current)
    escapeTimerRef.current = setTimeout(() => {
      escapeTimerRef.current = null
      setEscapeArmed(false)
    }, ESCAPE_ARM_MS)
  }

  /**
   * One capture-phase handler on the composer root, in a fixed order.
   *
   * Escape first: it is the only key with a suppression rule that depends on
   * what else is open, and giving it the first look is what keeps that rule in
   * one place.
   */
  const onComposerKeyDownCapture = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    handleEscape(event)
    handleRecall(event)
  }

  return (
    <div
      onKeyDownCapture={onComposerKeyDownCapture}
      onPaste={onPaste}
      className="shrink-0 px-4 pt-2 pb-3"
    >
      <div className="mx-auto flex w-full max-w-[46rem] flex-col gap-2">
        <AttachmentStrip
          images={images}
          onRemove={(id) => composerActions().removeImage(key, id)}
        />

        {failure !== null ? (
          <p role="alert" className="text-xs text-danger">
            {failure}
          </p>
        ) : null}

        {/* One card: the editor and its controls read as a single input rather
            than as stacked siblings. `focus-within` lifts the border to the
            accent so the whole card responds to the caret being in it. */}
        <div className="rounded-2xl border border-border bg-bg shadow-card transition-colors focus-within:border-accent">
          {/* `busy` never disables the editor. Typing while the agent works is
              the normal case — that draft is the steer. */}
          <ComposerEditor
            draftKey={key}
            sessionId={sessionId}
            value={draft}
            onChange={(next) => composerActions().setDraft(key, next)}
            onSubmit={submit}
            onMenuOpenChange={setSuggestionsOpen}
            placeholder={sessionId === null ? 'Start a new session…' : 'Send a message…'}
          />

          <div className="flex items-center gap-2 px-2 pb-2">
            <ModelControls
              models={models.data ?? []}
              selection={selection}
              disabled={!state.selectorsEnabled}
              onModel={(modelId) => composerActions().chooseModel(key, modelId)}
              onEffort={(effort) => composerActions().chooseEffort(key, effort)}
            />
            {escapeArmed ? (
              <span role="status" className="min-w-0 flex-1 truncate text-xs text-warn">
                Press Escape again to stop the agent
              </span>
            ) : (
              <span className="min-w-0 flex-1 truncate text-xs text-ink-3">{state.hint}</span>
            )}
            <SendControls state={state} onRun={submit} onSteer={submit} onStop={stop} />
          </div>
        </div>
      </div>
    </div>
  )
}
