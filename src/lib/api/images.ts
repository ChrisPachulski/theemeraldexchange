import type { CSSProperties } from 'react'
import { apiUrl } from './base'

// Artwork through media-core's GET /api/media/images/{kind}/{id}?w=: resized
// WebP behind the session cookie. TMDB art is fetched by the server, never
// hotlinked; the server snaps `w` up to its ladder (92 185 342 500 780 1280 1920).

/** Widths a poster tile's srcset offers. */
export const POSTER_WIDTHS = [185, 342, 500]
// ponytail: one sizes hint for every poster tile (they are 108-168 CSS px);
// per-site sizes if a much larger tile ever appears.
const POSTER_SIZES = '168px'

// A TMDB image is keyed by its file name (alphanumeric stem, jpg or png), as
// media-core validates it.
const TMDB_HOST = 'image.tmdb.org'
const TMDB_PREFIX = `https://${TMDB_HOST}/t/p/`
const NAME = /^[A-Za-z0-9]{1,64}\.(?:jpg|png)$/
const ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i

function tmdbName(p: string): string | null {
  let name: string | undefined
  if (p.startsWith(TMDB_PREFIX)) name = /^[a-z0-9]+\/([^/]+)$/.exec(p.slice(TMDB_PREFIX.length))?.[1]
  else if (p.startsWith('/') && !ABSOLUTE.test(p)) name = p.slice(1)
  return name && NAME.test(name) ? name : null
}

function onTmdbHost(url: string): boolean {
  try {
    return new URL(url, 'https://base.invalid').hostname === TMDB_HOST
  } catch {
    return false
  }
}

/** A TMDB image (a bare `/x.jpg` poster_path, or a TMDB CDN URL at any size
 *  as Radarr's remoteUrl and stored watchlist rows carry) through the server
 *  at width `w`. Null for anything else. */
export function tmdbImage(pathOrUrl: string | null | undefined, w: number): string | null {
  const name = pathOrUrl ? tmdbName(pathOrUrl) : null
  return name ? apiUrl(`/api/media/images/tmdb/${name}`, { w }) : null
}

/** A srcset of {@link tmdbImage} at each width, or undefined. */
export function tmdbSrcSet(pathOrUrl: string | null | undefined, widths: number[]): string | undefined {
  if (!pathOrUrl || !tmdbName(pathOrUrl)) return undefined
  return widths.map((w) => `${tmdbImage(pathOrUrl, w)} ${w}w`).join(', ')
}

/** Local artwork the scan found (album or audiobook cover, photo). */
export function mediaImage(kind: 'album' | 'audiobook' | 'photo', id: number, w: number): string {
  return apiUrl(`/api/media/images/${kind}/${id}`, { w })
}

/** The URL to load for artwork from any source: TMDB (bare path or URL)
 *  through the server, any other absolute URL (Sonarr's TVDB art) as is.
 *  Null when there is nothing safe to load. */
export function artSrc(raw: string | null | undefined, w: number): string | null {
  if (!raw) return null
  return ABSOLUTE.test(raw) && !onTmdbHost(raw) ? raw : tmdbImage(raw, w)
}

export type ImgProps = { src: string; srcSet?: string; sizes?: string; style?: CSSProperties }

/** `<img>` props for a poster tile: {@link artSrc} plus a srcset for TMDB art
 *  and the blurhash painted underneath until the image loads. */
export function posterImg(raw: string | null | undefined, blurhash?: string | null): ImgProps | null {
  const src = artSrc(raw, 342)
  if (!src) return null
  const srcSet = tmdbSrcSet(raw, POSTER_WIDTHS)
  return { src, srcSet, sizes: srcSet && POSTER_SIZES, style: blurhashStyle(blurhash) }
}

// ── Blurhash (https://github.com/woltapp/blurhash), decode only ───────

const B83 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~'
const d83 = (s: string) => [...s].reduce((v, c) => v * 83 + B83.indexOf(c), 0)
const toLinear = (v: number) => {
  const x = v / 255
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
}
const toSrgb = (v: number) => {
  const x = Math.min(1, Math.max(0, v))
  return Math.round((x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055) * 255)
}
const signPow = (v: number, e: number) => Math.sign(v) * Math.abs(v) ** e

/** RGBA pixels (w*h*4) of a blurhash, or null when it is malformed. */
export function decodeBlurhash(hash: string, w: number, h: number): Uint8ClampedArray | null {
  if (hash.length < 6 || [...hash].some((c) => !B83.includes(c))) return null
  const size = d83(hash[0])
  const nx = (size % 9) + 1
  const ny = Math.floor(size / 9) + 1
  if (hash.length !== 4 + 2 * nx * ny) return null
  const maxAc = (d83(hash[1]) + 1) / 166
  const colors: number[][] = []
  for (let i = 0; i < nx * ny; i++) {
    if (i === 0) {
      const v = d83(hash.slice(2, 6))
      colors.push([v >> 16, (v >> 8) & 255, v & 255].map(toLinear))
    } else {
      const v = d83(hash.slice(4 + 2 * i, 6 + 2 * i))
      colors.push([Math.floor(v / 361), Math.floor(v / 19) % 19, v % 19].map((q) => signPow((q - 9) / 9, 2) * maxAc))
    }
  }
  const px = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const basis = Math.cos((Math.PI * x * i) / w) * Math.cos((Math.PI * y * j) / h)
          const c = colors[i + j * nx]
          r += c[0] * basis
          g += c[1] * basis
          b += c[2] * basis
        }
      }
      const o = 4 * (x + y * w)
      px.set([toSrgb(r), toSrgb(g), toSrgb(b), 255], o)
    }
  }
  return px
}

const BLUR_PX = 32
const blurCache = new Map<string, CSSProperties | undefined>()

/** A background that paints the blurhash (stretched to the box) under an
 *  `<img>` until it loads; undefined without a hash or a 2D canvas. */
export function blurhashStyle(hash: string | null | undefined): CSSProperties | undefined {
  if (!hash) return undefined
  if (blurCache.has(hash)) return blurCache.get(hash)
  let style: CSSProperties | undefined
  const px = decodeBlurhash(hash, BLUR_PX, BLUR_PX)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = BLUR_PX
    const ctx = px && canvas.getContext('2d')
    if (ctx) {
      ctx.putImageData(new ImageData(px as Uint8ClampedArray<ArrayBuffer>, BLUR_PX, BLUR_PX), 0, 0)
      style = { backgroundImage: `url(${canvas.toDataURL()})`, backgroundSize: '100% 100%' }
    }
  } catch {
    // No canvas (jsdom, a locked-down browser): the tile's own background shows.
  }
  blurCache.set(hash, style)
  return style
}
