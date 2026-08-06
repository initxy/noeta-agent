/**
 * The REST client over `/api/v1`.
 *
 * One module per resource, each a thin typed function over `apiRequest`.
 * Endpoint knowledge stays inside this directory: no caller anywhere composes
 * a URL, sets a method, or reads a status code by hand — which is what makes
 * the contract's paths checkable in one place.
 */

export {
  API_BASE,
  ApiError,
  NETWORK_ERROR_STATUS,
  apiRequest,
  extractApiError,
  isApiError,
  queryString,
  readList,
} from './client'
export type { ApiRequestInit } from './client'

export { contentUrl, fetchHealth, fetchModels } from './meta'

export {
  createConnector,
  createProject,
  deleteConnector,
  deleteProject,
  getAgentConfig,
  getProject,
  listConnectors,
  listProjects,
  putAgentConfig,
  updateConnector,
  updateProject,
} from './projects'

export {
  answerQuestion,
  cancelSession,
  createSession,
  deleteSession,
  forkSession,
  getSession,
  interruptSession,
  listSessions,
  sendMessage,
  sessionEventsUrl,
  updateSession,
} from './sessions'

export { fileRawUrl, listFiles, readFileText } from './files'

export {
  conflictMtime,
  fetchPreviewChannel,
  isWriteConflict,
  resolveArtifacts,
  writeFileText,
} from './artifacts'

export { NOT_FORKABLE } from './sessions'

export { fetchRawEvents } from './trace'
