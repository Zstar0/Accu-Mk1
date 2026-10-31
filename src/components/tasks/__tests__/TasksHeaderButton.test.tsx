import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

const navigateTo = vi.hoisted(() => vi.fn())
vi.mock('@/store/ui-store', () => ({
  useUIStore: { getState: () => ({ navigateTo }) },
}))

describe('TasksHeaderButton', () => {
  it('opens the Tasks page', async () => {
    const { TasksHeaderButton } =
      await import('@/components/tasks/TasksHeaderButton')
    render(<TasksHeaderButton />)
    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }))
    expect(navigateTo).toHaveBeenCalledWith('tasks', 'overview')
  })
})
