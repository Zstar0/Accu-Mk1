import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MethodsGuide } from '@/components/hplc/MethodsGuide'

describe('MethodsGuide — in-app lifecycle guide dialog', () => {
  it('opens from the trigger button and shows the lifecycle content', async () => {
    const user = userEvent.setup()
    render(<MethodsGuide />)

    // Closed by default — content not in the document
    expect(
      screen.queryByText(/Methods & Instruments — the Lifecycle/i)
    ).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /methods guide/i }))

    expect(
      await screen.findByText(/Methods & Instruments — the Lifecycle/i)
    ).toBeInTheDocument()
    // Load-bearing content: the draft-invisibility trap and the one-default rule
    expect(screen.getByText(/Forgot to activate\?/i)).toBeInTheDocument()
    expect(screen.getByText(/One default per service/i)).toBeInTheDocument()
    // Lifecycle steps present
    expect(
      screen.getByText(/Create the method — it starts as a draft/i)
    ).toBeInTheDocument()
    expect(screen.getByText(/Revise, don't edit/i)).toBeInTheDocument()
  })
})
