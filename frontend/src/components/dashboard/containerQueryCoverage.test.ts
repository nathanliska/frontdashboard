import { describe, expect, it } from 'vitest'

/**
 * A container-scoped variant with no `@container` ancestor never matches — the element simply
 * stays in its default state forever. Nothing throws, no class goes missing from the stylesheet,
 * and jsdom has no layout, so neither the type checker nor the rest of the suite can see it. Only
 * a human resizing a widget would, which is the regression this replaces.
 */
const CONTAINER_VARIANT = /className=\{?["'`][^"'`]*@(?:max|min)-\[/
const DECLARES_CONTAINER = /className=\{?["'`][^"'`]*@container\b/

// Vite resolves this at build time, so it needs no glob dependency of its own.
const sources = import.meta.glob('./**/*.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const scanned = Object.entries(sources).filter(([path]) => !path.endsWith('.test.tsx'))

describe('container query coverage', () => {
  it('finds dashboard sources to scan', () => {
    // Discovery that finds nothing passes every assertion below it, which reads from the outside
    // exactly like having checked them all.
    expect(scanned.length).toBeGreaterThan(0)
  })

  it('declares @container in any file that uses a container-scoped variant', () => {
    const offenders = scanned
      .filter(([, source]) => CONTAINER_VARIANT.test(source) && !DECLARES_CONTAINER.test(source))
      .map(([path]) => path)

    expect(offenders).toEqual([])
  })
})
