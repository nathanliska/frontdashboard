// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ClockWidget } from './ClockWidget'

describe('ClockWidget', () => {
  it('shows a shared clock in its zone', () => {
    render(<ClockWidget config={{ timezone: 'Asia/Tokyo' }} isSharedDashboard />)
    expect(screen.getByText(/· Asia\/Tokyo$/)).toBeInTheDocument()
  })

  it('reads a zone this browser cannot format as unset, rather than failing to render', () => {
    render(<ClockWidget config={{ timezone: 'Not/A_Zone' }} isSharedDashboard />)
    expect(screen.getByText(/· UTC$/)).toBeInTheDocument()
  })
})
