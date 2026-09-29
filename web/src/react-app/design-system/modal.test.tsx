import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Modal } from './modal'

afterEach(() => {
  cleanup()
})

describe('Modal', () => {
  it('renders nothing when closed', () => {
    render(
      <Modal open={false} onClose={vi.fn()} title="New project">
        <p>body</p>
      </Modal>,
    )
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByText('body')).toBeNull()
  })

  it('shows the title and children when open', () => {
    render(
      <Modal open onClose={vi.fn()} title="New project">
        <p>body</p>
      </Modal>,
    )
    const dialog = screen.getByRole('dialog', { name: 'New project' })
    expect(dialog).toBeTruthy()
    expect(screen.getByText('body')).toBeTruthy()
  })

  it('closes on the close button', () => {
    const onClose = vi.fn()
    render(
      <Modal open onClose={onClose} title="New project">
        <p>body</p>
      </Modal>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on Escape', () => {
    const onClose = vi.fn()
    render(
      <Modal open onClose={onClose} title="New project">
        <input aria-label="field" />
      </Modal>,
    )
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on a backdrop mousedown, but not on one that starts inside', () => {
    const onClose = vi.fn()
    render(
      <Modal open onClose={onClose} title="New project">
        <p>body</p>
      </Modal>,
    )
    // A mousedown on the card must not dismiss.
    fireEvent.mouseDown(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()

    // The backdrop is the dialog's parent; a mousedown whose target IS the
    // backdrop closes.
    const backdrop = screen.getByRole('dialog').parentElement as HTMLElement
    fireEvent.mouseDown(backdrop)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
