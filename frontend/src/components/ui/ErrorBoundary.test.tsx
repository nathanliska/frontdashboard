// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ErrorBoundary } from './ErrorBoundary'

function Boom({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error('render exploded')
  return <p>content</p>
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    // React logs the caught error itself, and componentDidCatch logs again on purpose. Silenced so
    // a passing run stays readable — asserted on below rather than merely suppressed.
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders children when nothing throws', () => {
    render(
      <ErrorBoundary fallback={() => <p>fallback</p>}>
        <Boom shouldThrow={false} />
      </ErrorBoundary>,
    )

    expect(screen.getByText('content')).toBeInTheDocument()
    expect(screen.queryByText('fallback')).not.toBeInTheDocument()
  })

  it('shows the fallback instead of unmounting the tree, and logs the crash', () => {
    render(
      <div>
        <p>sibling survives</p>
        <ErrorBoundary label="test widget" fallback={() => <p>fallback</p>}>
          <Boom shouldThrow={true} />
        </ErrorBoundary>
      </div>,
    )

    expect(screen.getByText('fallback')).toBeInTheDocument()
    // The point of the boundary: everything outside it is still on screen. Without one, React
    // unmounts the whole tree and this assertion fails along with the app.
    expect(screen.getByText('sibling survives')).toBeInTheDocument()

    const logged = vi.mocked(console.error).mock.calls.map((call) => String(call[0]))
    expect(logged.some((message) => message.includes('Render error in test widget'))).toBe(true)
  })

  it('reset() re-renders the children, so a transient crash can recover', () => {
    // Read at render time rather than passed as a prop: `reset()` re-renders the *same* children
    // element the parent already created, so a prop captured then would still say "throw".
    let failing = true

    function Flaky() {
      if (failing) throw new Error('render exploded')
      return <p>content</p>
    }

    render(
      <ErrorBoundary
        fallback={(reset) => (
          <button
            type="button"
            onClick={() => {
              failing = false
              reset()
            }}
          >
            Try again
          </button>
        )}
      >
        <Flaky />
      </ErrorBoundary>,
    )

    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(screen.getByText('content')).toBeInTheDocument()
  })
})
