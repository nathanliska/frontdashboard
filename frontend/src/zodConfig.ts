import { z } from 'zod'

// Our CSP refuses eval, so zod's JIT never runs; jitless stops the probe the browser logs as a CSP
// violation. The generated contract imports this first (scripts/import-zod-config.mjs).
z.config({ jitless: true })
