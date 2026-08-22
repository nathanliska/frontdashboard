// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '../../stores/ui'
import { Sidebar } from './Sidebar'

vi.mock('../notifications/NotificationPanel', () => ({
  NotificationPanel: () => <div data-testid="notifications" />,
}))

beforeEach(() => {
  useUIStore.setState({ sidebarCollapsed: false, mobileSidebarOpen: false })
})

const draw = () =>
  render(
    <MemoryRouter>
      <Sidebar />
    </MemoryRouter>,
  )

describe('Sidebar', () => {
  it('shows the labels until the user collapses the rail', () => {
    draw()
    expect(screen.getByText('Dashboards')).toBeInTheDocument()
    expect(screen.getByLabelText('Collapse sidebar')).toBeInTheDocument()
  })

  it('drops to icons on the stored choice', () => {
    useUIStore.setState({ sidebarCollapsed: true })
    draw()

    expect(screen.queryByText('Dashboards')).toBeNull()
    expect(screen.getByLabelText('Expand sidebar')).toBeInTheDocument()
  })

  it('labels the drawer even for someone who collapsed the rail', () => {
    // Below the `nav` breakpoint the drawer is the only navigation there is, and it opens at full
    // width — honouring a collapse meant for a docked rail would serve bare icons for no reason.
    useUIStore.setState({ sidebarCollapsed: true, mobileSidebarOpen: true })
    draw()

    expect(screen.getByText('Dashboards')).toBeInTheDocument()
    // The scrim carries the same label, so this counts rather than expecting one.
    expect(screen.getAllByLabelText('Close navigation')).toHaveLength(2)
  })
})
