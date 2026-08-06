/**
 * The two directions between a draft string and the editor's node tree.
 *
 * Both are one function each, and both are where the round trip is either
 * exact or silently lossy — so the two traps that cost the reference real bugs
 * are paid here, once:
 *
 * 1. **Join root children with a single `\n`.** `root.getTextContent()` puts a
 *    blank line between block children, so serializing through it turns every
 *    newline in the user's draft into two, on every keystroke. The draft is a
 *    string the user typed; the editor may not re-punctuate it.
 * 2. **Place the caret at the element level, not at the end of the last
 *    child.** `selectEnd()` on a draft that ends in a chip puts the caret
 *    *inside* an atomic node, where the next character either vanishes or
 *    splits the token. `select(n, n)` on the last paragraph puts it after the
 *    chip, which is where the user is looking.
 *
 * (The third trap — read before `editor.update()` — belongs to the sync plugin
 * that calls these, not to the functions themselves.)
 */

import { $createParagraphNode, $createTextNode, $getRoot, $isElementNode } from 'lexical'
import type { DraftSegment, MentionTable } from '@/app/draft/tokens'
import { splitDraft } from '@/app/draft/tokens'
import { leadingSlashCommand } from '@/app/draft/triggers'
import { $createDraftTokenNode } from './token-node'
import type { DraftTokenNode } from './token-node'

/** The editor's contents as a draft string. Trap 1 lives on the join. */
export function $serializeDraft(): string {
  return $getRoot()
    .getChildren()
    .map((child) => child.getTextContent())
    .join('\n')
}

function $nodeForSegment(segment: DraftSegment, mentions: MentionTable) {
  if (segment.kind === 'skill') return $createDraftTokenNode(segment.text, 'skill')
  // A chip only renders for a mention the draft is *known* to carry. An
  // `@someone` the user typed in prose is prose, and dressing it as a file
  // reference would be the editor asserting something it does not know.
  if (segment.kind === 'mention' && mentions[segment.value] !== undefined) {
    return $createDraftTokenNode(segment.text, 'mention')
  }
  return $createTextNode(segment.text)
}

/**
 * Replace the editor's contents with `draft`.
 *
 * One paragraph per line, so the serialization above is the exact inverse. The
 * draft-initial `/name` is peeled off the first line before the split, because
 * it is the one token whose meaning depends on where it is rather than on how
 * it is spelled.
 */
export function $renderDraft(draft: string, mentions: MentionTable): void {
  const root = $getRoot()
  root.clear()

  const command = leadingSlashCommand(draft)
  const lines = draft.split('\n')

  lines.forEach((line, index) => {
    const paragraph = $createParagraphNode()
    let rest = line
    if (index === 0 && command !== null) {
      const token: DraftTokenNode = $createDraftTokenNode(`/${command}`, 'command')
      paragraph.append(token)
      rest = line.slice(command.length + 1)
    }
    for (const segment of splitDraft(rest)) paragraph.append($nodeForSegment(segment, mentions))
    root.append(paragraph)
  })

  const last = root.getLastChild()
  if ($isElementNode(last)) {
    const end = last.getChildrenSize()
    last.select(end, end)
  }
}
