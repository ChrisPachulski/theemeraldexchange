/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('public Apple release pages', () => {
  it('serves a complete canonical privacy policy', () => {
    const html = read('public/privacy.html')

    expect(html).toContain('<h1>Privacy Policy</h1>')
    expect(html).toContain('https://theemeraldexchange.com/privacy')
    expect(html).toContain('pachun95@gmail.com')
    for (const fact of [
      'developer collects no personal data',
      'server address remains',
      'opaque device identifier remains',
      'no third-party analytics',
    ]) {
      expect(html.toLowerCase()).toContain(fact)
    }
  })

  it('serves useful support without requiring the app', () => {
    const html = read('public/support.html')

    expect(html).toContain('<h1>Support</h1>')
    expect(html).toContain('pachun95@gmail.com')
    expect(html).toContain('href="/privacy"')
    expect(html.toLowerCase()).toContain('self-hosted media server')
    expect(html).toContain('Before you contact support')
  })

  it('keeps the legal pages accessible and responsive', () => {
    const css = read('public/legal.css')

    expect(css).toContain(':focus-visible')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).toContain('@media (max-width: 680px)')
  })

  it('publishes the associated-domain webcredentials contract', () => {
    const association = JSON.parse(
      read('public/.well-known/apple-app-site-association'),
    ) as {
      webcredentials?: { apps?: string[] }
    }

    expect(association).toEqual({
      webcredentials: {
        apps: ['8PS43TX4WW.com.theemeraldexchange.app'],
      },
    })
  })

  it('routes release endpoints before the SPA fallback', () => {
    const config = read('netlify.toml')
    const privacy = config.indexOf('from = "/privacy"')
    const support = config.indexOf('from = "/support"')
    const association = config.indexOf(
      'for = "/.well-known/apple-app-site-association"',
    )
    const fallback = config.indexOf('from = "/*"')

    expect(privacy).toBeGreaterThan(-1)
    expect(support).toBeGreaterThan(-1)
    expect(association).toBeGreaterThan(-1)
    expect(privacy).toBeLessThan(fallback)
    expect(support).toBeLessThan(fallback)
    expect(config.slice(association)).toContain('Content-Type = "application/json"')
  })
})
