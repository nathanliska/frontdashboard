// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useConnectionStore } from '../../stores/connection'
import { ConnectionDot } from './ConnectionDot'

// Asserted through the container rather than a query: the dot is deliberately `aria-hidden`, so it
// has no accessible identity to look it up by, and that absence is the thing worth pinning.
describe('ConnectionDot', () => {
  it('draws nothing while the stream is healthy', () => {
    useConnectionStore.setState({ status: 'connected' })
    const { container } = render(<ConnectionDot />)

    expect(container.firstChild).toBeNull()
  })

  it('draws nothing before the first connect', () => {
    // Signed out, or still opening: absent is not the same as degraded, and a dot on the login
    // screen would be a lie.
    useConnectionStore.setState({ status: 'connecting' })
    const { container } = render(<ConnectionDot />)

    expect(container.firstChild).toBeNull()
  })

  it('draws the marker once the stream is reconnecting', () => {
    useConnectionStore.setState({ status: 'reconnecting' })
    const { container } = render(<ConnectionDot />)

    // Decorative: the hosts supply the wording, so this must not be announced a second time.
    expect(container.firstChild).toHaveAttribute('aria-hidden', 'true')
  })

  it('keeps the caller in charge of where it sits', () => {
    useConnectionStore.setState({ status: 'reconnecting' })
    const { container } = render(<ConnectionDot className="-top-0.5 -right-0.5" />)

    expect(container.firstChild).toHaveClass('-top-0.5')
  })
})
