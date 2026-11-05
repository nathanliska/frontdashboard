// The generated contract builds its schemas at import, and zod reads `jitless` as each is built, so
// the config must be the contract's own first import; anywhere else, bundling can order it later.
import { readFileSync, writeFileSync } from 'node:fs'

// A plain path, run from frontend/ by npm: knip reads `new URL(…, import.meta.url)` as an import.
const path = 'src/api/generated/contract.ts'
writeFileSync(path, `import '../../zodConfig'\n${readFileSync(path, 'utf8')}`)
