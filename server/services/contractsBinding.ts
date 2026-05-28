// Loads the napi-rs native addon (@emerald/contracts-napi) under ESM.
//
// The addon's index.js ends with `module.exports = loadBinding()` — a
// dynamic require that cjs-module-lexer cannot statically analyze. Under
// Node's ESM loader that means `import * as contracts` (and named imports)
// resolve every export to `undefined`; the real functions live only on the
// synthetic `default`. A star-import therefore yields undefined functions
// that throw at call time, not import time — so the failure stays invisible
// until the first stream-token sign, device-token decrypt, or principal mint
// actually runs. `createRequire` returns the genuine export object directly.
import { createRequire } from 'node:module'
import type * as ContractsTypes from '@emerald/contracts-napi'

export const contracts: typeof ContractsTypes = createRequire(import.meta.url)(
  '@emerald/contracts-napi',
)
export type { ContractsTypes }
