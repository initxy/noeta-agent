/**
 * The product-level metadata endpoints: is the backend up, what can it run,
 * and where do attachment bytes come from.
 *
 * Health is called for a reason beyond the status line it renders: it is the
 * single request that proves the whole wire — vite's `/api` proxy in dev, the
 * backend's static mount in a build, the JSON envelope, and the error path
 * when nothing is listening.
 */

import { API_BASE, apiRequest, readList } from './client'
import type { HealthPayload, Model } from '../types/wire'

export function fetchHealth(signal?: AbortSignal): Promise<HealthPayload> {
  return apiRequest<HealthPayload>('/health', { signal })
}

export async function fetchModels(signal?: AbortSignal): Promise<Model[]> {
  return readList<Model>(await apiRequest<unknown>('/models', { signal }), 'models')
}

/**
 * The URL for one content-addressed blob.
 *
 * A URL rather than a fetch: image bytes never travel the event stream, so the
 * chat bubble renders them by handing this straight to an `<img src>` and
 * letting the browser cache them by hash — which is free and exact, since the
 * hash *is* the cache key.
 */
export function contentUrl(hash: string): string {
  return `${API_BASE}/content/${encodeURIComponent(hash)}`
}
