// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ParticipantDots } from './ParticipantDots'

function person(name: string) {
  return { user_id: `id-${name}`, display_name: name }
}

describe('ParticipantDots', () => {
  it('renders nothing for an empty list', () => {
    const { container } = render(<ParticipantDots participants={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows one initial dot per participant and names everyone accessibly', () => {
    render(<ParticipantDots participants={[person('Ada'), person('Zoe')]} />)
    const group = screen.getByRole('img', { name: 'For Ada, Zoe' })
    expect(group).toHaveTextContent('A')
    expect(group).toHaveTextContent('Z')
  })

  it('caps at three dots and overflows into +N, still naming everyone', () => {
    render(
      <ParticipantDots
        participants={[person('Ada'), person('Ben'), person('Cy'), person('Di'), person('Ed')]}
      />,
    )
    const group = screen.getByRole('img', { name: 'For Ada, Ben, Cy, Di, Ed' })
    expect(group).toHaveTextContent('+2')
    expect(group).not.toHaveTextContent('D')
    expect(group).not.toHaveTextContent('E')
  })
})
