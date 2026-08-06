/**
 * What the two menus offer, and where it comes from.
 *
 * ## Slash commands
 *
 * A slash command pins a **built-in skill** for one turn through the SDK's
 * `activations` channel: the send path strips the leading `/name` and posts it
 * as `skills`. Two consequences shape this module.
 *
 * First, **the menu is a convenience, not the gate**. A name the menu never
 * offered still works, because the send path parses the draft rather than
 * remembering what was clicked. That is what keeps the catalogue's current
 * poverty from being a functional limit.
 *
 * Second, **there is no catalogue endpoint**. Skills live in a project's
 * `.noeta/skills`, which the workspace file surface deliberately prunes
 * (hidden entries at any depth), so the client cannot enumerate them. What it
 * *can* see is which skills this session has actually activated — the
 * transcript carries a `skill_activated` frame per activation — so those are
 * offered as real, verified names. A `GET /projects/{id}/skills` would replace
 * this lane wholesale; until then this is the only source that cannot be wrong.
 *
 * ## File mentions
 *
 * `searchWorkspaceFiles` is the remote-search seam. Today it lists and ranks,
 * because the listing endpoint takes no query; the signature is the one an
 * eventual `?query=` slots into without touching a caller.
 */

import { useMemo } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'
import fuzzysort from 'fuzzysort'
import { listFiles } from '@/app/api'
import { useConversation } from '../../state/conversation-store'
import { useDebouncedValue } from './use-debounced-value'

/** One row. `id` is what gets committed into the draft; `label` is what shows. */
export interface Suggestion {
  id: string
  label: string
  description?: string
}

/** Both menus cap at eight rows, filtered or not. A menu you scroll is a list. */
export const SUGGESTION_LIMIT = 8

/** Long enough to swallow a burst of typing, short enough not to feel laggy. */
export const MENTION_SEARCH_DEBOUNCE_MS = 150

/**
 * Rank by fuzzy match, or take the head of the source order on an empty query.
 *
 * Non-matches are dropped and the cap applies to both branches, which is what
 * keeps a bare `@` from rendering a project's whole file tree.
 */
export function rankSuggestions<T extends Suggestion>(
  query: string,
  items: readonly T[],
): T[] {
  if (query === '') return items.slice(0, SUGGESTION_LIMIT)
  return fuzzysort
    .go(query, items, { keys: ['label', 'description'], limit: SUGGESTION_LIMIT })
    .map((result) => result.obj)
}

/**
 * Built-in commands the product itself defines.
 *
 * Empty on purpose rather than by omission: this product manages no skill
 * registry (the DB-backed one was deleted), so every name it could offer would
 * be a guess about the workspace. The list exists as the place a real one goes.
 */
export const BUILT_IN_SLASH_COMMANDS: readonly Suggestion[] = []

/**
 * The slash catalogue for a session: built-ins, then the skills this
 * conversation has been seen to activate.
 */
export function useSlashCommands(sessionId: string | null): Suggestion[] {
  const conversation = useConversation(sessionId)
  const items = conversation.items
  return useMemo(() => {
    const seen = new Set<string>()
    const used: Suggestion[] = []
    for (const item of items) {
      if (item.kind !== 'skill' || seen.has(item.skill)) continue
      seen.add(item.skill)
      used.push({ id: item.skill, label: item.skill, description: 'Used in this session' })
    }
    used.sort((left, right) => left.label.localeCompare(right.label))
    return [...BUILT_IN_SLASH_COMMANDS, ...used]
  }, [items])
}

/**
 * Search the session's workspace for files matching `query`.
 *
 * The ranking happens here rather than in the caller so that the day the
 * endpoint learns `?query=`, the whole change is inside this function.
 */
export async function searchWorkspaceFiles(
  sessionId: string,
  query: string,
  signal?: AbortSignal,
): Promise<Suggestion[]> {
  const files = await listFiles(sessionId, signal)
  return rankSuggestions(
    query,
    files.map((file) => ({ id: file.path, label: file.path })),
  )
}

/**
 * The mention menu's rows, one request per **settled** query.
 *
 * The debounce lives here rather than at the call site so it cannot be
 * forgotten: it sits in front of the query key, so a fast typist spends one
 * round trip instead of one per keystroke, and `keepPreviousData` means the
 * menu narrows in place rather than blanking between them.
 */
export function useFileSuggestions(
  sessionId: string | null,
  query: string,
  enabled: boolean,
): UseQueryResult<Suggestion[], Error> {
  const settled = useDebouncedValue(query, MENTION_SEARCH_DEBOUNCE_MS)
  return useQuery({
    queryKey: ['composer', 'file-search', sessionId, settled],
    queryFn: ({ signal }) => searchWorkspaceFiles(sessionId as string, settled, signal),
    enabled: enabled && sessionId !== null,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  })
}
