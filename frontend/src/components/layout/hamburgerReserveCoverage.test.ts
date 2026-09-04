import { describe, expect, it } from 'vitest'

/**
 * Below the `nav` breakpoint the sidebar is off-canvas and AppShell floats a menu button over the
 * top-left corner, so a page header reserves `pl-12` for it and gives that back above the same
 * breakpoint. `PAGE_HEADER_RESERVE` holds both halves; this guards that they stay held — a header
 * spelling them out inline can lose either one, and a reserve that outlives the button leaves a
 * 48px indent no layout explains. jsdom has no media queries, so only a resize would show it.
 */
const RESERVE = 'pl-12'
const DECLARING_MODULE = '/pageHeaderReserve.ts'
// The class list around it may be reordered; the anchor may not go missing, which is what the
// first case below is for.
const HAMBURGER = /([a-z][\w-]*):hidden fixed top-3 left-3/

const sources = import.meta.glob(['../../**/*.ts', '../../**/*.tsx'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const scanned = Object.entries(sources).filter(([path]) => !path.includes('.test.'))
// By suffix, not by key: a glob normalizes a same-directory hit to `./AppShell.tsx`, so matching
// the full pattern-relative path finds nothing and every pairing below then reads as broken.
const shell = scanned.find(([path]) => path.endsWith('/AppShell.tsx'))?.[1] ?? ''
const breakpoint = shell.match(HAMBURGER)?.[1]

describe('hamburger reserve coverage', () => {
  it('finds the breakpoint that hides the floating menu button', () => {
    // Discovery that finds nothing passes every assertion below it, which reads from the outside
    // exactly like having checked them all.
    expect(scanned.length).toBeGreaterThan(0)
    expect(breakpoint).toBeDefined()
  })

  it('releases the reserve at exactly that breakpoint', () => {
    const declaring = scanned.find(([path]) => path.endsWith(DECLARING_MODULE))?.[1]

    expect(declaring).toBeDefined()
    expect(declaring).toContain(RESERVE)
    expect(declaring).toContain(`${breakpoint}:pl-0`)
  })

  it('keeps the reserve in one place', () => {
    // A header spelling the pair out again is how the two halves drifted apart before there was
    // somewhere for them to live together.
    const offenders = scanned
      .filter(([path, source]) => source.includes(RESERVE) && !path.endsWith(DECLARING_MODULE))
      .map(([path]) => path)

    expect(offenders).toEqual([])
  })
})
