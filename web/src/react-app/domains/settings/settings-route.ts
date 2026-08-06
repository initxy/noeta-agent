/**
 * The settings tab vocabulary and the parse of `:tab`.
 *
 * A `:tab` param is user-editable text, so it needs a total function: every
 * input maps to a real tab, and an unrecognised one asks for a redirect rather
 * than rendering an empty shell at a URL that will stay in history.
 *
 * `connections` is listed here as a *name* even though its panel belongs to
 * another domain. Domains may not import siblings, so the shell is what pairs
 * the tab with the panel that renders it.
 */

export const SETTINGS_TABS = ['general', 'agent', 'connections', 'memory', 'advanced'] as const

export type SettingsTab = (typeof SETTINGS_TABS)[number]

export const DEFAULT_SETTINGS_TAB: SettingsTab = 'general'

export const SETTINGS_TAB_LABELS: Record<SettingsTab, string> = {
  general: 'General',
  agent: 'Agent',
  connections: 'Connections',
  memory: 'Memory',
  advanced: 'Advanced',
}

export interface ParsedSettingsTab {
  tab: SettingsTab
  /** True when the URL named something else and should be rewritten. */
  redirect: boolean
}

export function parseSettingsTab(raw: string | undefined): ParsedSettingsTab {
  const candidate = (raw ?? '').trim().toLowerCase()
  const match = SETTINGS_TABS.find((tab) => tab === candidate)
  return match ? { tab: match, redirect: false } : { tab: DEFAULT_SETTINGS_TAB, redirect: true }
}
