/**
 * Turning a draft into the two fields `POST /sessions/{id}/messages` takes.
 *
 * ```
 * "/review  look at @src/a%20b.ts"  ->  { text: "look at @src/a b.ts", skills: ["review"] }
 * ```
 *
 * **A slash command is a skill activation, not a different endpoint.** It rides
 * the SDK's `activations` channel, which pins built-in skill names for the turn
 * *pre-loop*; the request body already carries `skills`, so the send path
 * strips the leading `/name` and sends the rest as the goal. Nothing about the
 * wire changes — a turn with a command and a turn without differ by one array.
 *
 * **A mention is text.** Our message body has no `file` part, and it does not
 * need one: the agent has `read`, so a path in the goal is a thing it can act
 * on. All the encoding does is keep the value a single `@token` inside the
 * draft; resolving un-escapes it so the model sees the path the user picked.
 * Only values the mention table knows are decoded — an `@word` the user merely
 * typed is left exactly as typed, which is what stops a literal `%20` in prose
 * from turning into a space.
 *
 * **A merged queue is still a draft.** The queue drains as one string joined by
 * blank lines and is resolved here, once, so a queued `/review …` still pins
 * its skill and the whole batch is still one goal.
 */

import type { MentionTable } from './tokens'
import { splitDraft } from './tokens'

/**
 * The invocation match, and it is wider than the chip rule in `./triggers`: a
 * bare `/review` with no goal parses here and yields empty text, which the
 * composer treats as "nothing to send". A command modifies a goal; it is not
 * one.
 *
 * `[ \t]+` and not `\s+` is deliberate — a newline after the name is the shape
 * a merged queue produces, and reading the second queued message as the
 * command's arguments would be reading the user's paragraph break as syntax.
 */
export const SLASH_INVOCATION_RE = /^\/([A-Za-z0-9_-]+)(?:[ \t]+([\s\S]*))?$/

export interface ResolvedDraft {
  /** The goal, with mentions decoded and any leading command removed. */
  text: string
  /** Built-in skill names to pin for this turn. At most one today. */
  skills: string[]
}

/**
 * Resolve a draft for sending.
 *
 * Pure and total: every string resolves, and a draft with no tokens and no
 * command resolves to its own trimmed self — which is what keeps the plain
 * "type a sentence and press Enter" path byte-identical to what it was before
 * the grammar existed.
 */
export function resolveDraft(draft: string, mentions: MentionTable = {}): ResolvedDraft {
  const decoded = splitDraft(draft)
    .map((segment) =>
      segment.kind === 'mention' && mentions[segment.value] !== undefined
        ? `@${segment.value}`
        : segment.text,
    )
    .join('')
    .trim()

  const invocation = SLASH_INVOCATION_RE.exec(decoded)
  if (invocation === null) return { text: decoded, skills: [] }
  return { text: (invocation[2] ?? '').trim(), skills: [invocation[1]] }
}
