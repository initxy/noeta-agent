import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CodeBlock } from './code-block'
import { StreamingProvider } from './streaming-context'

/**
 * The one behaviour worth a test here is the gate: the highlighter must not run
 * while the turn is streaming, and it must run once the turn parks. Everything
 * else about shiki is shiki's problem, so it is mocked out entirely — the test
 * would otherwise load a WASM regex engine to assert on a boolean.
 */

vi.mock('@/react-app/infra/highlighter', () => ({
  highlightCode: vi.fn(async ({ code }: { code: string }) => `<pre><code>${code}!</code></pre>`),
}))

const { highlightCode } = await import('@/react-app/infra/highlighter')
const highlight = vi.mocked(highlightCode)

afterEach(() => {
  cleanup()
  highlight.mockClear()
})

const show = (streaming: boolean, code = 'const a = 1') =>
  render(
    <StreamingProvider streaming={streaming}>
      <CodeBlock code={code} lang="ts" />
    </StreamingProvider>,
  )

describe('the transcript code block', () => {
  it('renders plain text and does not highlight while streaming', async () => {
    show(true)

    expect(screen.getByTestId('code-block').getAttribute('data-highlighted')).toBe('false')
    expect(screen.getByText('const a = 1')).toBeTruthy()
    expect(highlight).not.toHaveBeenCalled()
  })

  it('highlights once the turn parks', async () => {
    show(false)

    await waitFor(() =>
      expect(screen.getByTestId('code-block').getAttribute('data-highlighted')).toBe('true'),
    )
    expect(highlight).toHaveBeenCalledTimes(1)
  })

  it('does not highlight a fence with no language', () => {
    render(<CodeBlock code="plain" />)

    expect(highlight).not.toHaveBeenCalled()
    expect(screen.getByTestId('code-block').getAttribute('data-highlighted')).toBe('false')
  })

  it('falls back to plain text when the highlighter declines', async () => {
    highlight.mockResolvedValueOnce(null)
    show(false)

    await waitFor(() => expect(highlight).toHaveBeenCalled())
    expect(screen.getByTestId('code-block').getAttribute('data-highlighted')).toBe('false')
  })

  it('drops highlighting again if the same block starts streaming', async () => {
    const { rerender } = show(false)
    await waitFor(() =>
      expect(screen.getByTestId('code-block').getAttribute('data-highlighted')).toBe('true'),
    )

    rerender(
      <StreamingProvider streaming={true}>
        <CodeBlock code="const a = 1" lang="ts" />
      </StreamingProvider>,
    )

    // Stale colours over moving text is worse than no colours at all.
    expect(screen.getByTestId('code-block').getAttribute('data-highlighted')).toBe('false')
  })

  it('copies the block source to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    show(true, 'const a = 1')

    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))

    // The raw source it was handed, not the rendered DOM — so a highlighted and
    // a plain block copy the same bytes.
    expect(writeText).toHaveBeenCalledWith('const a = 1')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy())
    vi.unstubAllGlobals()
  })
})
