// @vitest-environment jsdom
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { setReduceMotion, storedReduceMotion } from './reduceMotion'
import { prefersReducedMotion } from './viewTransition'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')

// Selectors inside every `@media (prefers-reduced-motion: reduce)` block.
function reduceBlockSelectors(css: string): string[] {
  const out: string[] = []
  for (const m of css.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{/g)) {
    const start = m.index + m[0].length
    let i = start
    for (let depth = 1; depth > 0 && i < css.length; i++) {
      if (css[i] === '{') depth++
      else if (css[i] === '}') depth--
    }
    const body = css.slice(start, i - 1).replace(/\/\*[\s\S]*?\*\//g, '')
    for (const rule of body.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
      out.push(...rule[1].split(',').map((s) => s.trim().replace(/\s+/g, ' ')))
    }
  }
  return out
}

afterEach(() => {
  setReduceMotion(false)
})

describe('in-app Reduce motion', () => {
  it('sets the <html> attribute, persists, and counts as reduced motion', () => {
    expect(prefersReducedMotion()).toBe(false)
    setReduceMotion(true)
    expect(document.documentElement.hasAttribute('data-reduce-motion')).toBe(true)
    expect(storedReduceMotion()).toBe(true)
    expect(prefersReducedMotion()).toBe(true)
    setReduceMotion(false)
    expect(document.documentElement.hasAttribute('data-reduce-motion')).toBe(false)
    expect(storedReduceMotion()).toBe(false)
  })

  it('index.css mirrors every prefers-reduced-motion: reduce selector', () => {
    const indexCss = readFileSync(join(SRC, 'index.css'), 'utf8')
    const cssFiles = (readdirSync(SRC, { recursive: true }) as string[]).filter((f) => f.endsWith('.css'))
    const selectors = cssFiles.flatMap((f) => reduceBlockSelectors(readFileSync(join(SRC, f), 'utf8')))
    expect(selectors.length).toBeGreaterThan(10)
    const missing = selectors.filter((s) => {
      const mirror = s === ':root' ? ':root[data-reduce-motion]' : `:root[data-reduce-motion] ${s}`
      return !indexCss.includes(mirror)
    })
    expect(missing).toEqual([])
  })
})
