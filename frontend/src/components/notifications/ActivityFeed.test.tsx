// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ActivityEvent } from '../../api/notifications'
import { ActivityFeed } from './ActivityFeed'

function checked(eventId: number, text: string, minute: number, isChecked = true): ActivityEvent {
  return {
    event_id: eventId,
    event_type: 'list.item.checked',
    entity_type: 'list_item',
    entity_id: `item-${eventId}`,
    actor_id: 'user-1',
    actor_display_name: 'Example User',
    payload: {
      list_id: 'list-1',
      list_name: 'Groceries',
      text,
      values: { checked: isChecked },
    },
    created_at: new Date(Date.UTC(2026, 6, 17, 18, 50 + minute)).toISOString(),
  } as unknown as ActivityEvent
}

// Newest-first, a minute apart from 18:50 UTC, well inside the collapse window.
const RUN = [checked(3, 'Bread', 2, false), checked(2, 'Eggs', 1), checked(1, 'Milk', 0)]

describe('ActivityFeed run details', () => {
  it('collapses the run to one row and offers its events behind a closed disclosure', () => {
    render(<ActivityFeed activity={RUN} loading={false} />)

    expect(screen.getByText('You updated checkboxes in "Groceries".')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show 3 changes' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    // The point of collapsing: the members are not on the page until asked for.
    expect(screen.queryByText('You checked "Milk" in "Groceries".')).toBeNull()
  })

  it('names each event, unchecking included, once expanded', () => {
    render(<ActivityFeed activity={RUN} loading={false} />)

    fireEvent.click(screen.getByRole('button', { name: 'Show 3 changes' }))

    expect(screen.getByText('You checked "Milk" in "Groceries".')).toBeInTheDocument()
    expect(screen.getByText('You checked "Eggs" in "Groceries".')).toBeInTheDocument()
    // A run mixes both verbs, which is why the summary above says "updated".
    expect(screen.getByText('You unchecked "Bread" in "Groceries".')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Hide 3 changes' })).toBeInTheDocument()
  })

  it('keeps an open run open when Load more extends it downward', () => {
    // The mirror of the live-arrival case: an older page continues the run past the seam, so the
    // run's oldest event changes. Openness is held against the ids already opened, not that one.
    const { rerender } = render(<ActivityFeed activity={RUN} loading={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show 3 changes' }))

    rerender(
      <ActivityFeed
        activity={[...RUN, checked(0, 'Butter', -1), checked(-1, 'Jam', -2)]}
        loading={false}
      />,
    )

    expect(screen.getByRole('button', { name: 'Hide 5 changes' })).toBeInTheDocument()
  })

  it('keeps an open run open when a live event joins it', () => {
    const { rerender } = render(<ActivityFeed activity={RUN} loading={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show 3 changes' }))
    expect(screen.getByRole('button', { name: 'Hide 3 changes' })).toBeInTheDocument()

    // SSE puts the newest event at the front, so the run's representative changes underneath an
    // open row. Openness is held against the ids already opened, not that one.
    rerender(<ActivityFeed activity={[checked(4, 'Yoghurt', 3), ...RUN]} loading={false} />)

    expect(screen.getByRole('button', { name: 'Hide 4 changes' })).toBeInTheDocument()
  })

  it('gives a row that collapsed nothing no disclosure to open', () => {
    render(<ActivityFeed activity={[checked(1, 'Milk', 0)]} loading={false} />)

    expect(screen.getByText('You checked "Milk" in "Groceries".')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
