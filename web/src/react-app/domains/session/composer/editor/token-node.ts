/**
 * The chip: a `TextNode` whose text is the draft token itself.
 *
 * This is the shape that makes the single-string draft work. The node renders
 * as a pill, but `getTextContent()` still returns the exact source token, so
 * serializing the editor back to a draft is a join — there is no chip-to-token
 * encoder to keep in step with the parser, and no way for a round trip to
 * rewrite what the user typed.
 *
 * Two behaviours come from the node's **mode**, not from an override: created
 * in `token` mode, a chip deletes whole on one Backspace and refuses text
 * inserted into it. A half-eaten `@src/ap` left behind by a character-wise
 * delete would be a mention token that no longer names anything.
 *
 * `exportJSON` / `importJSON` exist because Lexical requires them of a
 * registered node. Nothing in this product serializes the editor to JSON — the
 * draft string *is* the serialization — so they are a formality kept honest
 * rather than a second persistence path.
 */

import { TextNode } from 'lexical'
import type { EditorConfig, LexicalUpdateJSON, NodeKey, SerializedTextNode, Spread } from 'lexical'

/**
 * `command` is the draft-initial `/name`; the rest are the bracket/`@` tokens
 * of the draft grammar that currently resolve to something. The reserved
 * shapes render as plain text until the phase that gives them metadata.
 */
export type DraftTokenKind = 'command' | 'mention' | 'skill'

export type SerializedDraftTokenNode = Spread<
  { tokenKind: DraftTokenKind },
  SerializedTextNode
>

const CHIP_BASE =
  'rounded px-1 py-px align-baseline text-[0.95em] font-medium whitespace-pre'

const CHIP_KIND: Record<DraftTokenKind, string> = {
  command: 'bg-accent/15 text-accent',
  mention: 'bg-surface-2 text-ink-2 ring-1 ring-border',
  skill: 'bg-warn/15 text-warn',
}

export class DraftTokenNode extends TextNode {
  __tokenKind: DraftTokenKind

  constructor(text: string, tokenKind: DraftTokenKind, key?: NodeKey) {
    super(text, key)
    this.__tokenKind = tokenKind
  }

  static getType(): string {
    return 'draft-token'
  }

  static clone(node: DraftTokenNode): DraftTokenNode {
    return new DraftTokenNode(node.__text, node.__tokenKind, node.__key)
  }

  createDOM(config: EditorConfig): HTMLElement {
    const dom = super.createDOM(config)
    dom.className = `${dom.className} ${CHIP_BASE} ${CHIP_KIND[this.__tokenKind]}`.trim()
    dom.setAttribute('data-draft-token', this.__tokenKind)
    return dom
  }

  updateDOM(prevNode: this, dom: HTMLElement, config: EditorConfig): boolean {
    const updated = super.updateDOM(prevNode, dom, config)
    if (prevNode.__tokenKind !== this.__tokenKind) return true
    return updated
  }

  /** A chip is one thing: no caret inside it, no text glued onto it. */
  canInsertTextBefore(): boolean {
    return false
  }

  canInsertTextAfter(): boolean {
    return false
  }

  static importJSON(serializedNode: SerializedDraftTokenNode): DraftTokenNode {
    return $createDraftTokenNode(serializedNode.text, serializedNode.tokenKind)
  }

  updateFromJSON(serializedNode: LexicalUpdateJSON<SerializedDraftTokenNode>): this {
    const node = super.updateFromJSON(serializedNode)
    node.__tokenKind = serializedNode.tokenKind
    return node
  }

  exportJSON(): SerializedDraftTokenNode {
    return { ...super.exportJSON(), tokenKind: this.__tokenKind }
  }
}

export function $createDraftTokenNode(text: string, tokenKind: DraftTokenKind): DraftTokenNode {
  // `token` mode is what makes the chip atomic; setting it here rather than
  // overriding `isToken()` keeps every internal check that reads the mode
  // agreeing with the one the editor renders.
  return new DraftTokenNode(text, tokenKind).setMode('token')
}
