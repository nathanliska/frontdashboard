import { describe, expect, it } from 'vitest'

/**
 * A container-scoped variant with no `@container` ancestor never matches — the element simply
 * stays in its default state forever. Nothing throws, no class goes missing from the stylesheet,
 * and jsdom has no layout, so neither the type checker nor the rest of the suite can see it. Only
 * a human resizing a widget would, which is the regression this replaces.
 */
// Inside any string, not only a plain `className="…"`: a variant composed through `cn()` is the
// same variant, and a match shape narrower than the usage lets a file through unchecked.
const CONTAINER_VARIANT = /["'`][^"'`\n]*@(?:max|min)-\[/
const DECLARES_CONTAINER = /["'`][^"'`\n]*@container\b/

// Vite resolves this at build time, so it needs no glob dependency of its own.
const sources = import.meta.glob('../../**/*.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

// Comments stripped: a comment naming `@container` in backticks declares nothing.
const scanned = Object.entries(sources)
  .filter(([path]) => !path.endsWith('.test.tsx'))
  .map(([path, source]) => [path, source.replace(/\/\*[\s\S]*?\*\/|(?<!:)\/\/.*$/gm, '')] as const)

describe('container query coverage', () => {
  it('finds sources to scan', () => {
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
