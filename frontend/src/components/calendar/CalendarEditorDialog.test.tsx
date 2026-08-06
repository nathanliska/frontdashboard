// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CalendarEditorDialog } from './CalendarEditorDialog'

// Asserting that the editor still appears would pass against the hand-rolled overlay this replaced,
// which rendered the same children. Every assertion here is on something only a real dialog does.
function renderDialog() {
  const onClose = vi.fn()
  render(
    <CalendarEditorDialog title="Edit event" onClose={onClose}>
      <button type="button">Inside</button>
    </CalendarEditorDialog>,
  )
  return { onClose }
}

describe('the event editor dialog', () => {
  it('closes on Escape', () => {
    const { onClose } = renderDialog()

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('names itself for assistive technology despite drawing no header', () => {
    renderDialog()

    expect(screen.getByRole('dialog', { name: 'Edit event' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Close dialog' })).toBeNull()
  })

  it('hides the page behind it from assistive technology', () => {
    const { baseElement } = render(
      <CalendarEditorDialog title="Edit event" onClose={vi.fn()}>
        <button type="button">Inside</button>
      </CalendarEditorDialog>,
    )

    // Radix marks up siblings rather than setting `aria-modal`, so the page is what carries the tell.
    const page = baseElement.querySelector('div:not([data-radix-portal])')
    expect(page?.getAttribute('aria-hidden')).toBe('true')
  })

  it('locks body scroll while it is open', () => {
    const { unmount } = render(
      <CalendarEditorDialog title="Edit event" onClose={vi.fn()}>
        <button type="button">Inside</button>
      </CalendarEditorDialog>,
    )

    expect(document.body.hasAttribute('data-scroll-locked')).toBe(true)

    unmount()

    expect(document.body.hasAttribute('data-scroll-locked')).toBe(false)
  })
})
