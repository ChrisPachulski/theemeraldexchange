# Flag Report: §17 Rust `Sub` Type Round-Trip Verification

> Source agent: r17-sub-type-roundtrip
> Date: 2026-05-25

## What was checked

Whether the `Sub` type proposed in §17 (`enum Sub { Plex(u64), Local(Ulid), Apple(String) }`) round-trips byte-identically through the §5.1 fixed-template canonical serializer for all provider-dispatching patterns specified in §8.3 (`plex:[0-9]+`, `local:[0-9A-HJKMNP-TV-Z]{26}`, `apple:[0-9]{6}\.[0-9a-f]{32}\.[0-9]{4}`).

## Verdict

**NEEDS-WORK.** Round-trip is correct for all valid inputs as Plex currently issues them, but a latent spec defect in §8.3's `plex:[0-9]+` pattern allows leading-zero inputs (`plex:00`, `plex:007`) that break byte-equality under designs (ii) and (iii). Design (i) `Sub(String)` is unconditionally safe. A small spec patch to §8.3 makes (ii)/(iii) provably safe; without it they are practically-safe-but-theoretically-broken.

## Findings

- **All four canonical inputs round-trip YES for all three designs**:
  - `plex:12345` — byte-equal under (i), (ii), (iii)
  - `plex:0` — byte-equal under (i), (ii), (iii) (Rust `u64::to_string(0)` = `"0"`, not `""` or `"0x0"`)
  - `local:01HXYZABCDEFGHJKMNPQRSTVWZ` — byte-equal; the `ulid` crate v1.x uses uppercase Crockford Base32 matching §8.3
  - `apple:001126.d3c6971f80c046fcab9876543210abcd.1616` — byte-equal; leading-zero `001126` is preserved because `kid` is `String`, not numeric
- **Leading-zero hazard for Plex numeric IDs (CRITICAL)**:
  - `plex:00` parses to `0u64`, re-serializes as `plex:0` → **mismatch**
  - `plex:007` parses to `7u64`, re-serializes as `plex:7` → **mismatch**
  - The §8.3 pattern `plex:[0-9]+` does NOT exclude leading zeros, but `u64` cannot preserve them
  - Plex's actual API never issues leading-zero IDs (database PKs are bare positive integers), so practical exposure is functionally zero
  - However, this is a latent spec defect: the pattern accepts what the numeric type cannot faithfully reproduce
- **Design ranking**:
  - Design (i) `Sub(String)` — unconditionally byte-identical to wire value regardless of any future Plex ID format change; cannot introduce locale, leading-zero, or radix bugs
  - Design (ii) `enum Sub { Plex(u64), Local(Ulid), Apple(String) }` — safe with §8.3 pattern tightening; required for provider-dispatching business logic
  - Design (iii) decomposed — same safety profile as (ii); useful only if code needs to inspect Apple sub-components independently

## Required fixes

1. **§8.3 plex pattern**: change `plex:[0-9]+` to `plex:0|plex:[1-9][0-9]*`. Explicitly excludes leading zeros at the validation layer.
2. **§13.1 test vectors**: add `tests/vectors/sub-namespace.json` invalid-input vector `"plex:007"` that the parser must reject.
3. **§17 interface boundary clarification** — adopt both designs at different use-sites:

```rust
// In stream_token module — HMAC path:
struct Claims {
    sub: String,   // validated by parse, carried verbatim into canonical template
    // ...other fields
}

// In sub module — business logic:
enum Sub { Plex(u64), Local(Ulid), Apple(String) }
fn parse_sub(s: &str) -> Result<Sub, SubError>;
```

The HMAC path uses `Sub(String)` to guarantee byte-equality. Business logic that needs to dispatch on provider type uses the typed enum from a separate parsing call. Both designs co-exist without conflict.

## Drop-in text (not applicable for r17)

N/A — fixes are spec patches to §8.3 and §13.1, not §19 ratification entries.
