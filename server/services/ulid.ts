// server/services/ulid.ts — minimal, crypto-backed ULID generator.
//
// The M1.5 contract (§8.1) requires a `local:` sub to be a 26-char uppercase
// Crockford Base32 ULID matching /^[0-9A-HJKMNP-TV-Z]{26}$/. We mint these for
// self-owned passkey users. Rather than pull a dependency whose default RNG is
// Math.random, this is ~15 lines using node:crypto.
//
// Layout (standard ULID): 48-bit millisecond timestamp (10 chars) + 80 bits of
// CSPRNG randomness (16 chars). The randomness uses `byte & 31`, which is
// perfectly uniform over 0..31 because 256 is an exact multiple of 32 (no
// modulo bias).

import { randomBytes } from 'node:crypto'

// Crockford Base32 alphabet (excludes I, L, O, U). Every symbol is within the
// contract's [0-9A-HJKMNP-TV-Z] class.
const ENC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const TIME_LEN = 10
const RAND_LEN = 16

/** Generate a 26-char Crockford Base32 ULID. `now` is injectable for tests. */
export function ulid(now: number = Date.now()): string {
  let ts = Math.floor(now)
  let time = ''
  for (let i = 0; i < TIME_LEN; i++) {
    time = ENC[ts % 32] + time
    ts = Math.floor(ts / 32)
  }

  const rnd = randomBytes(RAND_LEN)
  let rand = ''
  for (let i = 0; i < RAND_LEN; i++) rand += ENC[rnd[i] & 31]

  return time + rand
}

/** Mint a fresh self-owned identity sub: `local:<ulid>`. */
export function newLocalSub(now?: number): string {
  return `local:${ulid(now)}`
}
