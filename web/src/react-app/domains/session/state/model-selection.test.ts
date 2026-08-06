import { describe, expect, it } from 'vitest'
import type { Model } from '@/app/types'
import { resolveSelection } from './model-selection'

const model = (over: Partial<Model> & { id: string }): Model => ({
  label: over.id,
  default: false,
  efforts: [],
  default_effort: null,
  ...over,
})

const CATALOGUE: Model[] = [
  model({ id: 'fast', efforts: ['low', 'medium'], default_effort: 'low' }),
  model({ id: 'deep', default: true, efforts: ['low', 'medium', 'high'], default_effort: 'high' }),
  model({ id: 'plain' }),
]

describe('resolveSelection', () => {
  it('falls back to the catalogue default, then to the first entry', () => {
    expect(resolveSelection(CATALOGUE, { model: null, effort: null }).model?.id).toBe('deep')
    expect(
      resolveSelection([model({ id: 'only' })], { model: null, effort: null }).model?.id,
    ).toBe('only')
  })

  it('keeps an explicit choice', () => {
    const resolved = resolveSelection(CATALOGUE, { model: 'fast', effort: 'medium' })
    expect(resolved.model?.id).toBe('fast')
    expect(resolved.effort).toBe('medium')
  })

  it('drops a model that is no longer in the catalogue', () => {
    // `models.json` is user-edited: a stored choice can name a model that was
    // deleted, and that must not disable the composer.
    expect(resolveSelection(CATALOGUE, { model: 'retired', effort: null }).model?.id).toBe('deep')
  })

  it('drops an effort the chosen model does not offer — it would be a 422', () => {
    const resolved = resolveSelection(CATALOGUE, { model: 'fast', effort: 'high' })
    expect(resolved.effort).toBe('low')
    expect(resolved.efforts).toEqual(['low', 'medium'])
  })

  it('sends no effort at all when the model has no ladder', () => {
    const resolved = resolveSelection(CATALOGUE, { model: 'plain', effort: 'high' })
    expect(resolved.effort).toBeNull()
    expect(resolved.efforts).toEqual([])
  })

  it('ignores a default_effort the model does not list', () => {
    const broken = [model({ id: 'odd', efforts: ['low'], default_effort: 'max' })]
    expect(resolveSelection(broken, { model: null, effort: null }).effort).toBeNull()
  })

  it('keeps the backend ordering — it is an intensity ladder, not an alphabet', () => {
    expect(resolveSelection(CATALOGUE, { model: 'deep', effort: null }).efforts).toEqual([
      'low',
      'medium',
      'high',
    ])
  })

  it('resolves to nothing at all when the catalogue is empty', () => {
    const resolved = resolveSelection([], { model: 'fast', effort: 'low' })
    expect(resolved.model).toBeNull()
    expect(resolved.effort).toBeNull()
  })
})
