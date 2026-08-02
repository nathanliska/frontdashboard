// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { LoadingBlock, LoadingScreen } from './Spinner'

describe('loading indicators', () => {
  it('announces themselves, so a spinner is not silence to a screen reader', () => {
    const { unmount } = render(<LoadingScreen label="Loading authentication" />)
    expect(screen.getByRole('status')).toHaveAccessibleName('Loading authentication')
    unmount()

    render(<LoadingBlock />)
    expect(screen.getByRole('status')).toHaveAccessibleName('Loading')
  })

  it('keeps the in-content block at one height, which is what stops it moving mid-load', () => {
    // The Suspense fallback and every page's own loading state render this same element; if its
    // box changes the indicator jumps as one hands over to the other.
    render(<LoadingBlock />)
    expect(screen.getByRole('status').className).toContain('h-64')
  })

  it('holds both spinners back, so a wait that resolves fast never flashes one', () => {
    // jsdom runs no CSS, so assert the mechanism: the delay class wrapping each spinner.
    const block = render(<LoadingBlock />)
    expect(block.container.querySelector('.loading-appear')).not.toBeNull()
    block.unmount()

    const screenRender = render(<LoadingScreen label="Loading" />)
    expect(screenRender.container.querySelector('.loading-appear')).not.toBeNull()
  })
})
