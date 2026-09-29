/**
 * Slash-command and mention triggers, anchored to the **whole draft string**.
 *
 * This is the decision the rest of the composer is built on, so it is worth
 * stating plainly: a trigger is a match against the draft, not against a caret
 * offset and not against an editor node. Everything follows from that.
 *
 * - **A slash trigger means the draft is *nothing but* the query.** `^\/…$`
 *   admits `/`, `/rev`, `/re-view` and nothing else — a space, a second word or
 *   any other character closes the menu. Committing a command can therefore
 *   **replace the entire draft** and be provably safe, with no splice, no
 *   offset arithmetic and no way to eat text the user typed. There is
 *   deliberately no mid-text slash trigger.
 * - **A mention trigger means the draft *ends* in `@query`, at a word
 *   boundary.** Committing replaces that trailing run and nothing else. The
 *   boundary is the one place this departs from the reference, which triggers
 *   on any trailing `@…`: without it `mail bob@example.com` opens a file picker
 *   on `example.com` while the user is typing an address.
 *
 * Anchoring to the draft is also what lets the editor stay a view: the menu's
 * open/closed state is a pure function of a string, so it survives a re-render,
 * a session switch and a draft restored from storage without any of them
 * knowing the menu exists.
 */

import { encodeMentionValue } from './tokens'

/** The draft is exactly `/` plus an optional name run. */
export const SLASH_TRIGGER_RE = /^\/([A-Za-z0-9_-]*)$/

/**
 * The draft ends in `@query`, and the `@` starts the draft or follows
 * whitespace.
 *
 * The boundary is a **capturing** group rather than a lookbehind so the
 * replacement can put it back; a variable-length lookbehind would read better
 * and is not worth the engine-support question.
 */
export const MENTION_TRIGGER_RE = /(^|\s)@([^\s@]*)$/

/**
 * A committed slash command: `/name` followed by whitespace.
 *
 * The whitespace is required, and that is what keeps the pill and the menu from
 * fighting: while the name is still being typed the draft matches
 * {@link SLASH_TRIGGER_RE} and the menu is open; the space that ends the query
 * is the same space that turns it into a chip.
 */
export const LEADING_SLASH_RE = /^\/([A-Za-z0-9_-]+)(?=[ \t\n])/

export type TriggerKind = 'slash' | 'mention'

export interface DraftTrigger {
  kind: TriggerKind
  /** What the menu filters on. Empty when the trigger character was just typed. */
  query: string
}

/**
 * Which suggestion menu, if any, this draft is asking for.
 *
 * Slash is tested first. The two cannot both match — a draft that is only
 * `/foo` has no `@` — so the order is documentation rather than precedence.
 */
export function draftTrigger(draft: string): DraftTrigger | null {
  const slash = SLASH_TRIGGER_RE.exec(draft)
  if (slash !== null) return { kind: 'slash', query: slash[1] }
  const mention = MENTION_TRIGGER_RE.exec(draft)
  if (mention !== null) return { kind: 'mention', query: mention[2] }
  return null
}

/**
 * The draft after committing a slash command — the **whole** draft.
 *
 * It takes no previous draft because there is nothing in the previous draft
 * worth keeping: {@link SLASH_TRIGGER_RE} already established it was the query
 * and only the query.
 */
export function slashCommandDraft(name: string): string {
  return `/${name} `
}

/**
 * The draft after committing a mention: the trailing `@query` becomes the
 * encoded token plus a trailing space, and everything before the boundary is
 * preserved byte for byte.
 */
export function commitMention(draft: string, value: string): string {
  return draft.replace(
    MENTION_TRIGGER_RE,
    (_match, boundary: string) => `${boundary}@${encodeMentionValue(value)} `,
  )
}

/**
 * The command a draft carries as a chip, or null.
 *
 * Deliberately narrower than the send path's invocation match: this one wants
 * whitespace after the name, so a bare `/review` reads as "still choosing"
 * rather than flickering into a chip under the open menu.
 */
export function leadingSlashCommand(draft: string): string | null {
  const match = LEADING_SLASH_RE.exec(draft)
  return match === null ? null : match[1]
}
