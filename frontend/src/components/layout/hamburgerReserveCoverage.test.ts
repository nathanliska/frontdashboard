import { describe, expect, it } from 'vitest'
import { PAGE_HEADER_RESERVE } from './pageHeaderReserve'

/**
 * Below the `nav` breakpoint the sidebar is off-canvas and AppShell floats a menu button over the
 * top-left corner, so a page header reserves room for it and gives that back above the same
 * breakpoint. jsdom has no media queries, so only a resize would show either half drifting.
 */
const RESERVE = 'pl-12'
const DECLARING_MODULE = '/pageHeaderReserve.ts'
// The class list around it may be reordered; the anchor may not go missing, which is what the
// first case below is for.
const HAMBURGER = /([a-z][\w-]*):hidden fixed top-3 left-3/
// Rendered outside AppShell, so no floating button and nothing to reserve for. A new page with a
// heading goes either here or under the reserve; the third case says which it forgot.
const OUTSIDE_SHELL = [
  'ForgotPasswordPage',
  'InvitePage',
  'LoginPage',
  'NotFoundPage',
  'RegisterPage',
  'ResetPasswordPage',
  'VerifyEmailPage',
]

const sources = import.meta.glob(['../../**/*.ts', '../../**/*.tsx', '!../../**/*.test.*'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const scanned = Object.entries(sources)
// By suffix, not by key: a glob normalizes a same-directory hit to `./AppShell.tsx`, so matching
// the full pattern-relative path finds nothing and every pairing below then reads as broken.
const shell = scanned.find(([path]) => path.endsWith('/AppShell.tsx'))?.[1] ?? ''
const breakpoint = shell.match(HAMBURGER)?.[1]
const isPage = (page: string) => (path: string) => path.endsWith(`/pages/${page}.tsx`)

describe('hamburger reserve coverage', () => {
  it('finds the breakpoint that hides the floating menu button', () => {
    // Discovery that finds nothing passes every assertion below it, which reads from the outside
    // exactly like having checked them all.
    expect(scanned.length).toBeGreaterThan(0)
    expect(breakpoint).toBeDefined()
  })

  it('releases the reserve at exactly that breakpoint', () => {
    expect(PAGE_HEADER_RESERVE.split(' ')).toEqual([RESERVE, `${breakpoint}:pl-0`])
  })

  it('applies the reserve on every page with a heading inside the shell', () => {
    const headed = scanned.filter(
      ([path, source]) => path.includes('/pages/') && source.includes('<h1'),
    )
    expect(headed.length).toBeGreaterThan(0)

    const outside = ([path]: [string, string]) => OUTSIDE_SHELL.some((page) => isPage(page)(path))
    // Applied, not merely imported: an import alone is what a header that forgot the class has.
    const applied = (source: string) =>
      /\bPAGE_HEADER_RESERVE\b/.test(source.replace(/^import\b.*$/gm, ''))
    const missing = headed
      .filter((entry) => !outside(entry) && !applied(entry[1]))
      .map(([path]) => path)
    expect(
      missing,
      'a heading under the floating menu button, or a page OUTSIDE_SHELL forgot',
    ).toEqual([])

    const stale = OUTSIDE_SHELL.filter((page) => !headed.some(([path]) => isPage(page)(path)))
    expect(stale, 'listed as outside the shell but no longer a page with a heading').toEqual([])
  })

  it('keeps the reserve in one place', () => {
    // Two copies of the pair can lose either half independently, with nothing to catch it.
    const spelled = new RegExp(`\\b${RESERVE}\\b`)
    const offenders = scanned
      .filter(([path, source]) => spelled.test(source) && !path.endsWith(DECLARING_MODULE))
      .map(([path]) => path)

    expect(offenders).toEqual([])
  })
})
