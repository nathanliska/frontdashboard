// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { CalendarEditorDraft } from '../../utils/calendar/calendarEditorDraftUtils'
import { CalendarEditor } from './CalendarEditor'

function makeDraft(overrides: Partial<CalendarEditorDraft> = {}): CalendarEditorDraft {
  return {
    title: 'Dentist appointment',
    description: '',
    eventLocation: '',
    startsAt: '2026-08-05T09:00',
    endsAt: '2026-08-05T10:30',
    allDay: false,
    recurrenceMode: 'none',
    recurrenceInterval: '1',
    recurrenceWeekdays: [],
    recurrenceEndsOn: '',
    ...overrides,
  }
}

function renderEditor(draft: CalendarEditorDraft = makeDraft()) {
  const onSubmit = vi.fn().mockResolvedValue(undefined)
  render(
    <CalendarEditor
      mode="edit"
      initialDraft={draft}
      onClose={vi.fn()}
      onSubmit={onSubmit}
      selectedDate={null}
    />,
  )
  return {
    onSubmit,
    endTime: () => (screen.getByLabelText('End time') as HTMLInputElement).value,
    duration: () => (screen.getByLabelText('Duration value') as HTMLInputElement).value,
    unit: screen.getByLabelText('Duration unit') as HTMLSelectElement,
    field: () => screen.getByLabelText('Duration value') as HTMLInputElement,
  }
}

describe('opening the editor', () => {
  it('puts the caret in the title rather than on Cancel', () => {
    renderEditor()

    expect(document.activeElement).toBe(screen.getByLabelText('Event title'))
  })
})

// Every assertion here is on the end time rather than on the duration reading correctly: the
// duration is derived from it either way, so a display-only assertion passes against the bug.
describe('duration unit', () => {
  it('changes how the duration reads without changing the event', () => {
    const editor = renderEditor()
    expect(editor.duration()).toBe('90')

    fireEvent.change(editor.unit, { target: { value: 'hours' } })

    expect(editor.endTime()).toBe('2026-08-05T10:30')
    expect(editor.duration()).toBe('1.5')
  })

  it('leaves the event alone through a round trip back to the original unit', () => {
    const editor = renderEditor()

    fireEvent.change(editor.unit, { target: { value: 'days' } })
    fireEvent.change(editor.unit, { target: { value: 'minutes' } })

    expect(editor.endTime()).toBe('2026-08-05T10:30')
    expect(editor.duration()).toBe('90')
  })

  it('submits the unedited end time after a unit change', async () => {
    const editor = renderEditor()

    fireEvent.change(editor.unit, { target: { value: 'hours' } })
    fireEvent.submit(screen.getByLabelText('Event title').closest('form') as HTMLFormElement)

    expect(editor.onSubmit).toHaveBeenCalledTimes(1)
    expect(editor.onSubmit.mock.calls[0][0]).toMatchObject({ endsAt: '2026-08-05T10:30' })
  })
})

describe('duration value', () => {
  // Typed one key at a time, because the field is controlled: what the previous keystroke left in
  // the DOM is what the next one appends to.
  function type(field: () => HTMLInputElement, text: string) {
    for (const character of text) {
      fireEvent.change(field(), { target: { value: field().value + character } })
    }
  }

  it('keeps a decimal point long enough to finish typing through it', () => {
    const editor = renderEditor()
    fireEvent.change(editor.unit, { target: { value: 'hours' } })

    fireEvent.change(editor.field(), { target: { value: '' } })
    type(editor.field, '1.5')

    expect(editor.duration()).toBe('1.5')
    expect(editor.endTime()).toBe('2026-08-05T10:30')
  })

  it('goes empty while the field is being cleared instead of snapping back', () => {
    const editor = renderEditor()

    fireEvent.change(editor.field(), { target: { value: '' } })

    expect(editor.duration()).toBe('')
    expect(editor.endTime()).toBe('2026-08-05T10:30')
  })

  it('restores what the event actually is when an unfinished value is left behind', () => {
    const editor = renderEditor()

    fireEvent.change(editor.field(), { target: { value: '' } })
    fireEvent.blur(editor.field())

    expect(editor.duration()).toBe('90')
    expect(editor.endTime()).toBe('2026-08-05T10:30')
  })

  it('applies a whole value as it is typed', () => {
    const editor = renderEditor()

    fireEvent.change(editor.field(), { target: { value: '45' } })

    expect(editor.endTime()).toBe('2026-08-05T09:45')
  })

  it('does not carry a half-typed value back across the all-day toggle', () => {
    const editor = renderEditor()
    fireEvent.change(editor.field(), { target: { value: 'nonsense' } })

    // Going all-day unmounts the control, so the blur that would normally tidy up never happens.
    fireEvent.click(screen.getByRole('checkbox', { name: 'All day' }))
    expect(screen.queryByLabelText('Duration value')).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: 'All day' }))

    expect(editor.duration()).toBe('90')
  })
})

describe('duration stepper', () => {
  it('steps from the event rather than from the rounded value on screen', () => {
    const editor = renderEditor()
    fireEvent.change(editor.unit, { target: { value: 'days' } })
    expect(editor.duration()).toBe('0.06')

    fireEvent.click(screen.getByLabelText('Increase duration'))

    // 90 minutes plus a quarter day, not 0.06 days plus one.
    expect(editor.endTime()).toBe('2026-08-05T16:30')
  })

  it('discards a half-typed value rather than stepping from it', () => {
    const editor = renderEditor()

    fireEvent.change(editor.field(), { target: { value: '' } })
    fireEvent.click(screen.getByLabelText('Increase duration'))

    expect(editor.endTime()).toBe('2026-08-05T10:45')
  })
})
