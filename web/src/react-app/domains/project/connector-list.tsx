/**
 * MCP connectors for the open project.
 *
 * The one rule that shapes this whole surface: **credentials are write-only
 * from the UI's point of view.** Every read path scrubs values to sorted
 * *name* lists (`header_names` / `env_names`), so there is nothing to render
 * but the names — and rendering `••••••` instead would be a lie the form
 * cannot round-trip, because saving it would send those bullets to the
 * backend as the new secret.
 *
 * The consequence is deliberate and stated in the UI: editing a connector's
 * credentials means supplying them again. That is the cost of never holding a
 * secret in a browser cache, and it is the right trade for a surface that is
 * touched once per connector.
 */

import { useState } from 'react'
import type { FormEvent } from 'react'
import type { Connector, ConnectorInput, ConnectorTransport } from '@/app/types'
import { Button, CenteredNote } from '@/react-app/design-system'
import { parseArgv, parseKeyValueLines } from './connector-input'
import { Callout, SelectField, SettingsSection, TextField } from './form-controls'
import { useConnectors, useCreateConnector, useDeleteConnector } from './project-queries'

function NameList({ label, names }: { label: string; names: string[] }) {
  if (names.length === 0) return null
  return (
    <p className="text-xs text-ink-3">
      {label}:{' '}
      <span className="font-mono text-ink-2">{names.join(', ')}</span>
    </p>
  )
}

function ConnectorRow({
  connector,
  onDelete,
  deleting,
}: {
  connector: Connector
  onDelete: () => void
  deleting: boolean
}) {
  const target = connector.transport === 'stdio' ? (connector.argv ?? []).join(' ') : connector.url
  return (
    <li className="flex items-start justify-between gap-3 rounded-md border border-border bg-surface px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-ink">{connector.alias}</p>
        {target ? (
          <p className="truncate font-mono text-xs text-ink-3" title={target}>
            {target}
          </p>
        ) : null}
        {/* Names only — the values never left the backend. */}
        <NameList label="Headers" names={connector.header_names ?? []} />
        <NameList label="Environment" names={connector.env_names ?? []} />
      </div>
      <Button variant="ghost" size="sm" onClick={onDelete} disabled={deleting}>
        Remove
      </Button>
    </li>
  )
}

function AddConnectorForm({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const create = useCreateConnector(projectId)
  const [transport, setTransport] = useState<ConnectorTransport>('http')
  const [alias, setAlias] = useState('')
  const [url, setUrl] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [headers, setHeaders] = useState('')
  const [env, setEnv] = useState('')
  const [error, setError] = useState<string | null>(null)

  function submit(event: FormEvent) {
    event.preventDefault()
    const trimmedAlias = alias.trim()
    if (!trimmedAlias) {
      setError('Give the connector an alias. The model sees it as mcp__<alias>__<tool>.')
      return
    }
    if (transport === 'http' && !url.trim()) {
      setError('An HTTP connector needs a URL.')
      return
    }
    if (transport === 'stdio' && !command.trim()) {
      setError('A stdio connector needs a command to run.')
      return
    }
    setError(null)

    // `transport` is always sent. The backend defaults it to `"http"`, so a
    // stdio connector that omitted it would be stored as an HTTP one with an
    // empty URL — accepted, listed, and dead on first use.
    const body: ConnectorInput =
      transport === 'http'
        ? {
            alias: trimmedAlias,
            transport,
            url: url.trim(),
            headers: parseKeyValueLines(headers),
          }
        : {
            alias: trimmedAlias,
            transport,
            // One already-split argv, which is what the store and
            // `McpServerSpec` both hold: the command is simply its first entry.
            argv: [command.trim(), ...parseArgv(args)],
            env: parseKeyValueLines(env),
          }
    create.mutate(body, { onSuccess: onDone })
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <TextField
        label="Alias"
        value={alias}
        onChange={(event) => setAlias(event.target.value)}
        placeholder="notion"
        autoComplete="off"
        hint="Tools arrive as mcp__<alias>__<tool>. It is scoped to this project."
      />
      <SelectField
        label="Transport"
        value={transport}
        onChange={(event) => setTransport(event.target.value as ConnectorTransport)}
      >
        <option value="http">HTTP</option>
        <option value="stdio">stdio (a local command)</option>
      </SelectField>

      {transport === 'http' ? (
        <>
          <TextField
            label="URL"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://mcp.example.com/sse"
            autoComplete="off"
            className="font-mono"
          />
          <TextField
            label="Headers"
            value={headers}
            onChange={(event) => setHeaders(event.target.value)}
            placeholder="Authorization=Bearer …"
            autoComplete="off"
            className="font-mono"
            hint="One key=value per entry. Values are stored on the backend and never returned."
          />
        </>
      ) : (
        <>
          <TextField
            label="Command"
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            placeholder="npx"
            autoComplete="off"
            className="font-mono"
          />
          <TextField
            label="Arguments"
            value={args}
            onChange={(event) => setArgs(event.target.value)}
            placeholder="-y @modelcontextprotocol/server-filesystem /srv/data"
            autoComplete="off"
            className="font-mono"
            hint="Space separated; quote an argument that contains spaces."
          />
          <TextField
            label="Environment"
            value={env}
            onChange={(event) => setEnv(event.target.value)}
            placeholder="API_TOKEN=…"
            autoComplete="off"
            className="font-mono"
            hint="One key=value per entry. Values are stored on the backend and never returned."
          />
        </>
      )}

      {error ? <Callout tone="danger">{error}</Callout> : null}
      {create.error ? <Callout tone="danger">{create.error.message}</Callout> : null}

      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" disabled={create.isPending}>
          {create.isPending ? 'Adding…' : 'Add connector'}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

export function ConnectorList({ projectId }: { projectId: string }) {
  const connectors = useConnectors(projectId)
  const remove = useDeleteConnector(projectId)
  const [adding, setAdding] = useState(false)

  if (connectors.isPending) return <CenteredNote>Loading connectors…</CenteredNote>

  const rows = [...(connectors.data ?? [])].sort((a, b) => a.alias.localeCompare(b.alias))

  return (
    <div className="flex flex-col">
      <SettingsSection
        title="MCP connectors"
        description="Extra tools this project's agent can call. Credential values are stored on the backend and never sent back to the browser — only their names are listed, so changing one means entering it again."
        footer={
          !adding ? (
            <Button variant="outline" onClick={() => setAdding(true)}>
              Add connector
            </Button>
          ) : null
        }
      >
        {connectors.error ? (
          <Callout tone="danger">
            The connector list could not be loaded. {connectors.error.message}
          </Callout>
        ) : null}

        {rows.length === 0 && !connectors.error ? (
          <p className="text-sm text-ink-3">No connectors in this project.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {rows.map((connector) => (
              <ConnectorRow
                key={connector.alias}
                connector={connector}
                deleting={remove.isPending}
                onDelete={() => remove.mutate(connector.alias)}
              />
            ))}
          </ul>
        )}
        {remove.error ? <Callout tone="danger">{remove.error.message}</Callout> : null}
      </SettingsSection>

      {adding ? (
        <SettingsSection title="New connector">
          <AddConnectorForm projectId={projectId} onDone={() => setAdding(false)} />
        </SettingsSection>
      ) : null}
    </div>
  )
}
