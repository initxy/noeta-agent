/**
 * "Undo last turn" — the affordance `rewind` exists for.
 *
 * The mirror of {@link EditAndRetry}, and the opposite retention. Where a fork
 * branches at a message and keeps both paths, undo re-bases **this** session's
 * stream to before the message: the turn and everything after it become dead
 * history, and — the part fork never does — the workspace files that span
 * edited are restored to their pre-turn bytes. There is no child session and
 * nothing to navigate to; the transcript truncates in place when the durable
 * `rewind` frame lands.
 *
 * Two guards define where it shows. It is offered only on the **latest**
 * committed user message (undoing an earlier one would silently discard turns
 * the user did not point at), and only while the session is **idle** (undo is a
 * finished-turn action; the backend refuses a running one). For v1 it is also
 * offered on **root sessions only** — rewinding across a fork boundary, where
 * history is spliced from the parent, is untested territory.
 *
 * Because it restores files under a directory shared by every session of the
 * project, the confirm step states that risk out loud (`REWIND_WORKSPACE_WARNING`)
 * before the click.
 */

import { useMemo, useState } from 'react'
import { isApiError } from '@/app/api'
import { NOT_REWINDABLE } from '@/app/api/sessions'
import type { ConversationItem, UserItem } from '@/app/fold'
import { Button } from '@/react-app/design-system'
import { useConversation } from '../state/conversation-store'
import { isLatestUserMessage } from './branch-model'
import { useRewind } from './branch-queries'
import { REWIND_WORKSPACE_WARNING } from './shared-workspace-note'

function failureMessage(error: unknown): string {
  if (isApiError(error)) {
    if (error.code === NOT_REWINDABLE) {
      return `This turn cannot be undone. ${error.message}`
    }
    return error.message
  }
  return error instanceof Error ? error.message : String(error)
}

export function UndoLastTurn({
  sessionId,
  item,
  isRoot,
}: {
  sessionId: string
  item: UserItem
  /** False on a fork child — undo is root-only for v1. */
  isRoot: boolean
}) {
  const [confirming, setConfirming] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const rewind = useRewind()

  const conversation = useConversation(sessionId)
  const userMessages = useMemo(
    () => conversation.items.filter(isUserItem),
    [conversation.items],
  )
  const latest = isLatestUserMessage(userMessages, item)

  // A running turn is not undoable (the backend 409s), and undo re-bases a
  // specific stream so it needs the anchor's stream id. Root-only for v1.
  if (!isRoot || !latest || conversation.running || item.taskId === null) return null

  if (!confirming) {
    return (
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => {
            setFailure(null)
            setConfirming(true)
          }}
          className="rounded-md px-1.5 py-0.5 text-[11px] text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink-2 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
        >
          Undo last turn
        </button>
      </div>
    )
  }

  const submit = async () => {
    if (item.taskId === null) return
    setFailure(null)
    try {
      await rewind.mutateAsync({
        sessionId,
        taskId: item.taskId,
        messageSeq: item.key,
      })
      setConfirming(false)
      // No navigation: the `rewind` SSE frame truncates the transcript in place.
    } catch (error) {
      setFailure(failureMessage(error))
    }
  }

  return (
    <div
      className="rounded-lg border border-border bg-surface px-3 py-2"
      data-testid="undo-last-turn"
    >
      <p className="text-sm text-ink-2">Undo this turn and everything after it?</p>
      <p className="mt-1.5 text-xs text-ink-3">{REWIND_WORKSPACE_WARNING}</p>
      {failure !== null ? (
        <p role="alert" className="mt-1.5 text-xs text-danger">
          {failure}
        </p>
      ) : null}
      <div className="mt-2 flex items-center justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={rewind.isPending}
          onClick={() => void submit()}
        >
          {rewind.isPending ? 'Undoing…' : 'Undo & restore files'}
        </Button>
      </div>
    </div>
  )
}

function isUserItem(item: ConversationItem): item is UserItem {
  return item.kind === 'user'
}
