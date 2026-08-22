import { describe, expect, it } from 'vitest'

/**
 * Below the `nav` breakpoint the sidebar is off-canvas and AppShell floats a menu button over the
 * top-left corner, so every page header reserves `pl-12` for it and gives that back above the same
 * breakpoint. The two live in different files with nothing tying them together: move one and a
 * header either sits under the button or keeps a 48px indent no layout explains. jsdom has no
 * media queries and both classes still exist, so only a person resizing the window would see it.
 */
const RESERVE = 'pl-12'
// The class list around it may be reordered; the anchor may not go missing, which is what the
// first case below is for.
const HAMBURGER = /([a-z][\w-]*):hidden fixed top-3 left-3/

const sources = import.meta.glob('../../**/*.tsx', {
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

  it('keeps a header reserving room for it', () => {
    const reserving = scanned.filter(([, source]) => source.includes(RESERVE))
    expect(reserving.length).toBeGreaterThan(0)
  })

  it('releases the reserve at exactly that breakpoint', () => {
    const offenders = scanned
      .filter(([, source]) => source.includes(RESERVE) && !source.includes(`${breakpoint}:pl-0`))
      .map(([path]) => path)

    expect(offenders).toEqual([])
  })
})
