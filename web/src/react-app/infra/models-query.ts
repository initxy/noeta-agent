/**
 * The model catalog.
 *
 * Cross-cutting in the same way health is: project settings pick a default
 * from it, and the composer will override per turn. Neither owns it, so it
 * sits in `infra/` beside the query client.
 *
 * The catalog comes from `models.json`, which the user edits. Two consequences
 * are designed for rather than guarded against: the list can be empty (a
 * machine with no gateway still boots), and a model can advertise an effort
 * this build has never heard of — `efforts` is a plain string list, so an
 * unknown effort renders as an option instead of disappearing.
 */

import { useQuery } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'
import { fetchModels } from '@/app/api'
import type { Model } from '@/app/types'

export const MODELS_QUERY_KEY = ['models'] as const

export function useModels(): UseQueryResult<Model[], Error> {
  return useQuery({
    queryKey: MODELS_QUERY_KEY,
    queryFn: ({ signal }) => fetchModels(signal),
    // The catalog is a file on disk that changes when the process restarts.
    staleTime: 5 * 60_000,
  })
}

/**
 * The efforts a model offers, given the id currently selected.
 *
 * Returns an empty list for "no model chosen" and for a model that is not in
 * the catalog — a stored default whose model was removed from `models.json`
 * must not silently keep an effort the new model does not have.
 */
export function effortsFor(models: readonly Model[], modelId: string | null): string[] {
  if (!modelId) return []
  return models.find((model) => model.id === modelId)?.efforts ?? []
}
