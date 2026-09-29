/**
 * Resolving a stored model/effort choice against the catalogue the backend
 * actually offers.
 *
 * The rule that makes this a function instead of two `??`s: **an effort outside
 * the chosen model's ladder is a 422 and must never leave the browser.** The
 * catalogue comes from `models.json`, which the user edits, so a stored choice
 * can name a model that no longer exists or an effort that model no longer
 * offers — and the resolution has to survive both without disabling the
 * composer.
 *
 * The effort list is rendered **in the order the backend sends it**: 0.5.1's
 * `effort_modes()` returns intensity order (`low … max`), so re-sorting it here
 * would only be a chance to get it wrong.
 */

import type { Model } from '@/app/types'

export interface ResolvedSelection {
  /** The model to send, or null when the backend offered no catalogue at all. */
  model: Model | null
  /** The effort to send, or null to let the backend apply the model's default. */
  effort: string | null
  /** The efforts this model offers, in the backend's order. */
  efforts: readonly string[]
}

const NO_SELECTION: ResolvedSelection = { model: null, effort: null, efforts: [] }

export function resolveSelection(
  models: readonly Model[],
  chosen: { model: string | null; effort: string | null },
): ResolvedSelection {
  if (models.length === 0) return NO_SELECTION

  const model =
    models.find((candidate) => candidate.id === chosen.model) ??
    models.find((candidate) => candidate.default) ??
    models[0]

  const efforts = model.efforts ?? []
  const effort =
    chosen.effort !== null && efforts.includes(chosen.effort)
      ? chosen.effort
      : model.default_effort !== null && efforts.includes(model.default_effort)
        ? model.default_effort
        : null

  return { model, effort, efforts }
}
