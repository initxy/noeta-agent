/**
 * "Edit that message and try again" — the affordance `fork` exists for.
 *
 * It branches at the message rather than rewriting it. The original stays put,
 * unmodified, because `fork` never writes the stream it branched from — which
 * is the whole difference from `rewind` (the separate "undo last turn", which
 * re-bases in place and restores workspace files).
 *
 * A fork is its **own** session now, nested under the source in the sidebar. So
 * submitting forks, sends the edit to the child, and **navigates there** — the
 * edited turn plays out in the new session, not in place. Two things are in the
 * user's face before they commit: the fork shares the project directory (files
 * the source wrote are still there), and the original is kept.
 */

import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { isApiError } from '@/app/api'
import { NOT_FORKABLE } from '@/app/api/sessions'
import { projectSessionRoute } from '@/app/routes'
import type { ConversationItem, UserItem } from '@/app/fold'
import { Button } from '@/react-app/design-system'
import { useConversation } from '../state/conversation-store'
import { isForkableMessage } from './branch-model'
import { useForkAndRetry } from './branch-queries'
import { SharedWorkspaceNote } from './shared-workspace-note'

function failureMessage(error: unknown): string {
  if (isApiError(error)) {
    if (error.code === NOT_FORKABLE) {
      // The engine's own reason is the useful half here: "not a user message",
      // "no prior turn to branch from", "not a root task".
      return `This message cannot be branched. ${error.message}`
    }
    return error.message
  }
  return error instanceof Error ? error.message : String(error)
}

export function EditAndRetry({
  projectId,
  sessionId,
  item,
}: {
  projectId: string
  sessionId: string
  item: UserItem
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const forkAndRetry = useForkAndRetry()
  const navigate = useNavigate()

  // A session now owns exactly one stream, so its conversation *is* the stream;
  // forkability is a fact about the messages on it.
  const items = useConversation(sessionId).items
  const userMessages = useMemo(() => items.filter(isUserItem), [items])
  const forkable = isForkableMessage(userMessages, item)

  if (!forkable || item.taskId === null) return null

  if (draft === null) {
    return (
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => {
            setFailure(null)
            setDraft(item.content)
          }}
          className="rounded-md px-1.5 py-0.5 text-[11px] text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink-2 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
        >
          Edit & retry
        </button>
      </div>
    )
  }

  const submit = async () => {
    const text = draft.trim()
    if (text === '' || item.taskId === null) return
    setFailure(null)
    try {
      const child = await forkAndRetry.mutateAsync({
        sessionId,
        taskId: item.taskId,
        messageSeq: item.key,
        text,
      })
      setDraft(null)
      // The edited turn plays out in the child session — go there.
      navigate(projectSessionRoute(projectId, child.sessionId))
    } catch (error) {
      setFailure(failureMessage(error))
    }
  }

  return (
    <div
      className="rounded-lg border border-border bg-surface px-3 py-2"
      data-testid="edit-and-retry"
    >
      <textarea
        rows={3}
        value={draft}
        aria-label="Edit message"
        onChange={(event) => setDraft(event.target.value)}
        className="w-full resize-none rounded-md border border-border bg-bg px-2.5 py-1.5 text-sm leading-relaxed text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent"
      />
      <p className="mt-1.5 text-xs text-ink-3">
        Sending this forks a new session from here. The original stays where it is.
      </p>
      <SharedWorkspaceNote className="mt-0.5" />
      {failure !== null ? (
        <p role="alert" className="mt-1.5 text-xs text-danger">
          {failure}
        </p>
      ) : null}
      <div className="mt-2 flex items-center justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={draft.trim() === '' || forkAndRetry.isPending}
          onClick={() => void submit()}
        >
          {forkAndRetry.isPending ? 'Forking…' : 'Fork & send'}
        </Button>
      </div>
    </div>
  )
}

function isUserItem(item: ConversationItem): item is UserItem {
  return item.kind === 'user'
}
