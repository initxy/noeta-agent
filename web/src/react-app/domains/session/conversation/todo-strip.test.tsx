import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { TodosItem } from '@/app/fold'
import { TodoStrip } from './todo-strip'

/**
 * The plan strip: what the reader sees of the checklist now that it lives above
 * the composer instead of in the scrolling step stream.
 */

function todos(items: TodosItem['todos']): TodosItem {
  return { kind: 'todos', key: 0, taskId: 't1', todos: items }
}

afterEach(() => {
  cleanup()
})

describe('the todo strip', () => {
  it('renders nothing when there is no plan', () => {
    const { container } = render(<TodoStrip todos={null} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing for an empty checklist', () => {
    const { container } = render(<TodoStrip todos={todos([])} />)
    expect(container.firstChild).toBeNull()
  })

  it('shows progress and the in-progress item collapsed, the full list when opened', () => {
    render(
      <TodoStrip
        todos={todos([
          { id: 'a', content: 'draft the plan', status: 'completed' },
          { id: 'b', content: 'write the code', status: 'in_progress' },
          { id: 'c', content: 'ship it', status: 'pending' },
        ])}
      />,
    )

    // Collapsed: the count and the current item are visible; the rest is not.
    expect(screen.getByText('1/3')).toBeTruthy()
    expect(screen.getByText('write the code')).toBeTruthy()
    expect(screen.queryByText('ship it')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Tasks/ }))
    expect(screen.getByText('draft the plan')).toBeTruthy()
    expect(screen.getByText('ship it')).toBeTruthy()
  })
})
