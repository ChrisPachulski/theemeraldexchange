import { describe, it, expect } from 'vitest'
import * as ts from 'typescript'

// Build-guard for the SPA TypeScript config.
//
// (a) Asserts that the hardening flags (`noImplicitThis`, `noImplicitAny`) are
//     present in tsconfig.app.json so they can't be silently dropped. The file
//     is JSONC (it has comments), so we parse it with the TypeScript compiler
//     API rather than JSON.parse.
// (b) Runs a real in-process typecheck of the SPA source under
//     tsconfig.app.json and asserts ZERO diagnostics, proving the flags don't
//     break the build and that no future implicit-any creeps in.
//
// NOTE: this file is part of `tsconfig.app.json`'s own `include` ("src"), so it
// must itself typecheck under the SPA type environment, whose `types` field is
// `["vite/client"]` — it deliberately excludes `@types/node`. That means we
// cannot use `node:path` or `__dirname` here (they aren't in scope). We resolve
// the repo root with the web-standard `URL` API from `import.meta.url` instead.
// The file lives at src/lib/, so the repo root is two directories up.

const repoRoot = new URL('../../', import.meta.url)
const configPath = ts.sys.resolvePath(new URL('tsconfig.app.json', repoRoot).pathname)

describe('tsconfig.app.json hardening', () => {
  it('declares noImplicitThis and noImplicitAny in compilerOptions', () => {
    const cfg = ts.readConfigFile(configPath, ts.sys.readFile)
    expect(cfg.error, 'tsconfig.app.json failed to parse').toBeUndefined()

    const compilerOptions = cfg.config?.compilerOptions
    expect(compilerOptions, 'compilerOptions missing from tsconfig.app.json').toBeDefined()
    expect(compilerOptions.noImplicitThis).toBe(true)
    expect(compilerOptions.noImplicitAny).toBe(true)
  })

  it('typechecks the SPA source with zero errors under tsconfig.app.json', () => {
    const parsed = ts.getParsedCommandLineOfConfigFile(
      configPath,
      { noEmit: true },
      { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
    )
    expect(parsed, 'failed to load tsconfig.app.json command line').toBeDefined()

    const program = ts.createProgram({
      rootNames: parsed!.fileNames,
      options: parsed!.options,
    })

    const diags = ts
      .getPreEmitDiagnostics(program)
      .filter((d) => d.category === ts.DiagnosticCategory.Error)

    const message =
      diags.length === 0
        ? ''
        : `tsconfig.app.json typecheck produced ${diags.length} error(s):\n` +
          diags
            .map((d) => {
              const text = ts.flattenDiagnosticMessageText(d.messageText, '\n')
              if (d.file && d.start !== undefined) {
                const { line, character } = d.file.getLineAndCharacterOfPosition(d.start)
                return `${d.file.fileName}:${line + 1}:${character + 1} - ${text}`
              }
              return text
            })
            .join('\n')

    expect(diags.length, message).toBe(0)
  })
})
