import { describe, expect, it } from 'vitest'
import {
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  createEditor,
} from 'lexical'
import type { LexicalEditor } from 'lexical'
import type { MentionTable } from '@/app/draft/tokens'
import { $renderDraft, $serializeDraft } from './draft-state'
import { DraftTokenNode } from './token-node'

/**
 * String → nodes → string, headless.
 *
 * Run against a bare `createEditor` rather than a mounted component because
 * this is the pair the whole single-string design rests on: if it is not an
 * identity, the editor rewrites the user's draft on every keystroke and
 * nothing above it can notice.
 */

const MENTIONS: MentionTable = { 'src/app.ts': 'file', 'a b.ts': 'file' }

function editorWith(): LexicalEditor {
  return createEditor({
    nodes: [DraftTokenNode],
    onError: (error) => {
      throw error
    },
  })
}

function roundTrip(draft: string, mentions: MentionTable = MENTIONS): string {
  const editor = editorWith()
  editor.update(
    () => {
      $renderDraft(draft, mentions)
    },
    { discrete: true },
  )
  return editor.getEditorState().read($serializeDraft)
}

const DRAFTS = [
  '',
  'plain words',
  '@src/app.ts',
  '/review look at the diff',
  '/review',
  'read @src/app.ts then stop',
  'read @a%20b.ts',
  '@nobody typed this',
  '[skill review] and more',
  'one\ntwo',
  'one\n\nthree',
  'trailing newline\n',
  '\nleading newline',
  'ends in a chip @src/app.ts',
]

describe('round trip', () => {
  for (const draft of DRAFTS) {
    it(`preserves ${JSON.stringify(draft)}`, () => {
      expect(roundTrip(draft)).toBe(draft)
    })
  }
})

describe('the serialization trap', () => {
  it('joins root children with a SINGLE newline', () => {
    // `root.getTextContent()` puts a blank line between block children, so
    // serializing through it doubles every newline the user typed — silently,
    // and on every keystroke.
    const editor = editorWith()
    editor.update(
      () => {
        $renderDraft('one\ntwo', MENTIONS)
      },
      { discrete: true },
    )
    expect(editor.getEditorState().read($serializeDraft)).toBe('one\ntwo')
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe('one\n\ntwo')
  })
})

describe('the caret trap', () => {
  it('lands after a trailing chip, not inside it', () => {
    // `selectEnd()` on a draft ending in a token puts the caret *inside* an
    // atomic node, where the next character is swallowed or splits the token.
    const editor = editorWith()
    editor.update(
      () => {
        $renderDraft('see @src/app.ts', MENTIONS)
      },
      { discrete: true },
    )
    editor.getEditorState().read(() => {
      const selection = $getSelection()
      expect($isRangeSelection(selection)).toBe(true)
      if (!$isRangeSelection(selection)) return
      expect(selection.anchor.type).toBe('element')
      const last = $getRoot().getLastChild()
      expect($isElementNode(last)).toBe(true)
      if (!$isElementNode(last)) return
      expect(selection.anchor.offset).toBe(last.getChildrenSize())
    })
  })
})

describe('chips', () => {
  const kinds = (draft: string, mentions: MentionTable = MENTIONS) => {
    const editor = editorWith()
    editor.update(
      () => {
        $renderDraft(draft, mentions)
      },
      { discrete: true },
    )
    return editor.getEditorState().read(() =>
      $getRoot()
        .getChildren()
        .flatMap((child) =>
          'getChildren' in child
            ? (child as never as { getChildren: () => unknown[] })
                .getChildren()
                .map((node) => (node instanceof DraftTokenNode ? node.__tokenKind : 'text'))
            : [],
        ),
    )
  }

  it('renders a known mention as a chip and an unknown @word as text', () => {
    expect(kinds('@src/app.ts')).toEqual(['mention'])
    expect(kinds('@nobody')).toEqual(['text'])
  })

  it('renders the draft-initial command as a chip, with the goal beside it', () => {
    expect(kinds('/review the diff')).toEqual(['command', 'text'])
  })

  it('does not chip a bare command — the menu is still open on that draft', () => {
    expect(kinds('/review')).toEqual(['text'])
  })

  it('does not chip a path that merely starts with a slash', () => {
    expect(kinds('/usr/bin/env is here')).toEqual(['text'])
  })

  it('renders a skill token as a chip', () => {
    expect(kinds('[skill review] go')).toEqual(['skill', 'text'])
  })
})
