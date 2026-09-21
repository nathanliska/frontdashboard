// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LoginPage } from '../../pages/LoginPage'
import { RegisterPage } from '../../pages/RegisterPage'
import { CALENDAR_WEEKDAY_LABELS_COMPACT } from '../../utils/calendar/calendarUtils'
import { AuthPitchLayout } from './AuthPitchLayout'

function renderLayout(children = <form aria-label="Sign in" />) {
  return render(
    <MemoryRouter>
      <AuthPitchLayout>{children}</AuthPitchLayout>
    </MemoryRouter>,
  )
}

afterEach(() => {
  vi.doUnmock('../../utils/calendar/calendarUtils')
  vi.resetModules()
})

const prefixOf = (el: Element, suffix: string) =>
  [...el.classList].find((name) => name.endsWith(`:${suffix}`))?.split(':')[0]

describe('AuthPitchLayout', () => {
  it('keeps the form ahead of the pitch for Tab and a screen reader', () => {
    const { container } = renderLayout()

    const form = container.querySelector('form') as Element
    const pitch = container.querySelector('section') as Element
    // Visual order is flipped with CSS `order`, which moves nothing in the DOM. Asserting on the
    // document position is the only way to see the two come apart.
    expect(form.compareDocumentPosition(pitch)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('turns the row and both columns at the same breakpoint', () => {
    const { container } = renderLayout()

    const root = container.firstElementChild as Element
    const formColumn = root.firstElementChild as Element
    const pitch = container.querySelector('section') as Element

    const row = prefixOf(root, 'flex-row')
    expect(row).toBeDefined()
    // All three or none. Apart, the pitch reaches its column at one width and the column exists at
    // another — which puts it above the form, or beside it on the wrong side.
    expect(prefixOf(pitch, 'order-1')).toBe(row)
    expect(prefixOf(formColumn, 'order-2')).toBe(row)
  })

  it('leaves the page a single h1, which the form owns', () => {
    renderLayout(<h1>FrontDashboard</h1>)

    // The pitch is hidden from nobody, but it is not the page: an h1 inside it would be a second
    // one here and the only one left if it were ever hidden at a breakpoint.
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('FrontDashboard')
  })

  it('takes the drawn week from the calendar the app actually renders', () => {
    const { container } = renderLayout()

    const initials = [...container.querySelectorAll('.grid-cols-7')][0]
    // The drawing is a promise about the product. Read from the calendar's own labels, a change of
    // first day moves both together; spelled out here, the front door would quietly disagree.
    expect([...(initials as Element).children].map((cell) => cell.textContent)).toEqual([
      ...CALENDAR_WEEKDAY_LABELS_COMPACT,
    ])
  })

  it('marks the column the clock names, whatever day the week starts on', async () => {
    // The real coupling test: flip the app's own labels to Monday-first and the marked column has
    // to follow Saturday to its new index. A column number hardcoded to the end passes only while
    // the app happens to start on Sunday.
    vi.resetModules()
    vi.doMock('../../utils/calendar/calendarUtils', () => ({
      CALENDAR_WEEKDAY_LABELS: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
      CALENDAR_WEEKDAY_LABELS_COMPACT: ['M', 'T', 'W', 'T', 'F', 'S', 'S'],
    }))
    const { AuthPitchLayout: MondayFirst } = await import('./AuthPitchLayout')

    const { container } = render(
      <MemoryRouter>
        <MondayFirst>
          <form aria-label="Sign in" />
        </MondayFirst>
      </MemoryRouter>,
    )

    const dates = [...container.querySelectorAll('.grid-cols-7')][1]
    const marked = [...dates.children].findIndex((cell) => cell.className.includes('bg-blue'))
    expect(marked).toBe(5)
    // The clock's long name is a free string beside the short one the mark resolves through, so
    // hold the pair together: 'Sat' marked under a clock reading "Sunday" would pass otherwise.
    expect(screen.getByText(/^(Sun|Mon|Tues|Wednes|Thurs|Fri|Satur)day$/)).toHaveTextContent(/^Sat/)
  })

  it('keeps the drawing out of the accessibility tree', () => {
    const { container } = renderLayout()

    // It restates what the prose beside it already says, so announcing "S M T W T F S 14 15 16"
    // on the sign-in page would be noise between the heading and the fields.
    const drawing = container.querySelector('[aria-hidden="true"]')
    expect(drawing).not.toBeNull()
    expect(drawing?.querySelector('.grid-cols-7')).not.toBeNull()
  })
})

describe.each([
  { name: 'LoginPage', Page: LoginPage },
  { name: 'RegisterPage', Page: RegisterPage },
])('$name', ({ Page }) => {
  it('tells a cold visitor what the app is', () => {
    render(
      <MemoryRouter>
        <Page />
      </MemoryRouter>,
    )

    expect(screen.getByRole('heading', { level: 2, name: /shared home screen/i })).toBeVisible()
  })
})
