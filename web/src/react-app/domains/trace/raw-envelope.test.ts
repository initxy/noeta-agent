import { describe, expect, it } from 'vitest'
import type { RawEnvelope } from '@/app/types'
import {
  UNKNOWN_TASK_ID,
  UNKNOWN_TYPE,
  asContentRef,
  envelopeKey,
  envelopePayload,
  envelopeSeq,
  envelopeTaskId,
  envelopeType,
  formatOccurredAt,
} from './raw-envelope'

/**
 * Every reader here degrades rather than throws, because the envelope it
 * cannot classify is precisely the one a developer opened this page to look
 * at. Losing the list to one bad envelope destroys the surface's only reason
 * to exist.
 */

const HASH = 'a'.repeat(64)

function raw(fields: Record<string, unknown>): RawEnvelope {
  return fields as unknown as RawEnvelope
}

describe('envelope readers', () => {
  it('reads the header fields of a well-formed envelope', () => {
    const envelope = raw({ task_id: 'root', seq: 7, type: 'TaskStarted', payload: { a: 1 } })

    expect(envelopeType(envelope)).toBe('TaskStarted')
    expect(envelopeTaskId(envelope)).toBe('root')
    expect(envelopeSeq(envelope)).toBe(7)
    expect(envelopePayload(envelope)).toEqual({ a: 1 })
  })

  it('names what is missing instead of throwing', () => {
    const envelope = raw({ payload: null })

    expect(envelopeType(envelope)).toBe(UNKNOWN_TYPE)
    expect(envelopeTaskId(envelope)).toBe(UNKNOWN_TASK_ID)
    expect(envelopeSeq(envelope)).toBeNull()
    expect(envelopePayload(envelope)).toBeNull()
  })

  it('does not mistake a missing seq for seq 0', () => {
    // Stream seq starts at 0, so folding "absent" into 0 collides with the
    // first real envelope of every stream on dedup.
    expect(envelopeSeq(raw({ task_id: 'root', type: 'X' }))).toBeNull()
    expect(envelopeSeq(raw({ task_id: 'root', seq: 0, type: 'X' }))).toBe(0)
    expect(envelopeSeq(raw({ seq: Number.NaN }))).toBeNull()
    expect(envelopeSeq(raw({ seq: '3' }))).toBeNull()
  })

  it('keys an envelope by (task, seq), and a seq-less one by position', () => {
    expect(envelopeKey(raw({ task_id: 'root', seq: 2 }), 9)).toBe('root#2')
    // Two streams at the same seq are different envelopes; a key that ignored
    // the task would make one of them disappear from the list.
    expect(envelopeKey(raw({ task_id: 'root', seq: 2 }), 0)).not.toBe(
      envelopeKey(raw({ task_id: 'sub-a', seq: 2 }), 1),
    )
    expect(envelopeKey(raw({ task_id: 'root' }), 4)).not.toBe(envelopeKey(raw({ task_id: 'root' }), 5))
  })
})

describe('ContentRef recognition', () => {
  it('recognises a tagged value carrying a content hash', () => {
    const ref = asContentRef({
      __canonical_tag__: 'content_ref',
      hash: HASH,
      media_type: 'text/plain',
      size: 4096,
    })

    expect(ref).toEqual({ hash: HASH, mediaType: 'text/plain', size: 4096, tag: 'content_ref' })
  })

  it('accepts a tagged value that spells the field content_hash', () => {
    expect(asContentRef({ __canonical_tag__: 'ref', content_hash: HASH })).toMatchObject({ hash: HASH })
  })

  it('reports the absent halves as null rather than guessing', () => {
    const ref = asContentRef({ __canonical_tag__: 'ref', hash: HASH })

    expect(ref?.mediaType).toBeNull()
    expect(ref?.size).toBeNull()
  })

  it('refuses anything that is not a tagged value with a real hash', () => {
    expect(asContentRef(null)).toBeNull()
    expect(asContentRef('a string')).toBeNull()
    expect(asContentRef([HASH])).toBeNull()
    // Untagged: a payload field that merely looks like a hash is not a ref.
    expect(asContentRef({ hash: HASH })).toBeNull()
    // Tagged, but the hash is not one `/content/{hash}` would accept.
    expect(asContentRef({ __canonical_tag__: 'ref', hash: 'deadbeef' })).toBeNull()
    expect(asContentRef({ __canonical_tag__: 'ref' })).toBeNull()
  })
})

describe('formatOccurredAt', () => {
  it('keeps millisecond precision', () => {
    // The ordering questions this page answers — did the cancel land before
    // the suspend? — are decided inside one second more often than not.
    expect(formatOccurredAt(1_700_000_000.123)).toMatch(/^\d{1,2}:\d{2}:\d{2}\.123$/)
  })

  it('renders nothing for a timestamp it cannot read', () => {
    expect(formatOccurredAt(undefined)).toBe('')
    expect(formatOccurredAt('2026-07-31')).toBe('')
    expect(formatOccurredAt(Number.POSITIVE_INFINITY)).toBe('')
  })
})
