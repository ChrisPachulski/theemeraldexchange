# PoToken (BotGuard / Proof-of-Origin) Integration

## Why BotGuard Cannot Be Self-Cracked

YouTube's BotGuard is a proprietary JavaScript attestation VM that runs inside
the browser.  It generates an opaque `pot` (Proof-of-Origin Token) by:

1. Loading an obfuscated JS payload from Google's servers.
2. Running a series of environment fingerprinting checks (browser globals,
   WebGL probes, timing checks).
3. Producing a signed challenge-response token the server can verify.

Reimplementing this in Rust is not feasible:

- The JS payload is re-obfuscated and re-keyed regularly by Google.
- The VM executes arbitrary bytecode; there is no stable opcode spec to target.
- The attestation deliberately detects headless/non-browser environments and
  produces invalid tokens there.

The only correct approach is to **run the real JS** in a real browser engine.
`bgutil-ytdlp-pot-provider` does exactly this via a headless Chromium
instance and exposes the result over HTTP.

Sources:
- yt-dlp `pot` director subsystem: https://github.com/yt-dlp/yt-dlp/tree/master/yt_dlp/extractor/_ytdlp_pot
- bgutil-ytdlp-pot-provider: https://github.com/brainicism/bgutil-ytdlp-pot-provider


## Running the External Minter

Pull and start the pre-built container:

```bash
docker run -d \
  --name pot-provider \
  --restart unless-stopped \
  -p 4416:4416 \
  ghcr.io/brainicism/bgutil-ytdlp-pot-provider:latest
```

Verify it is healthy:

```bash
# Should return {"status":"ok"} or similar
wget -qO- http://localhost:4416/health
```

Test a token mint:

```bash
wget -qO- --post-data='{"videoId":"dQw4w9WgXcQ","visitor_data":""}' \
     --header='Content-Type: application/json' \
     http://localhost:4416/get_pot
# {"poToken":"<base64url>","visitorData":"<updated>"}
```


## EEX_POT_PROVIDER_URL Environment Variable

Set this in your `.env` or `docker-compose.yml`:

```env
# Base URL of the running bgutil-ytdlp-pot-provider instance.
# No trailing slash.  Omit to disable PoToken (streams may be throttled).
EEX_POT_PROVIDER_URL=http://localhost:4416
```

When the variable is **absent**, `HttpMinterProvider` returns `Ok(None)` and
`ytresolve` proceeds without a token.  YouTube may still serve streams at lower
quality or with increased buffering when the token is absent.


## How the Token Attaches

### Player request body (Player context)

The InnerTube `/youtubei/v1/player` POST body gains a new top-level key:

```rust
// In resolve(), after building `player_body: serde_json::Value`:
use ytresolve::potoken::{HttpMinterProvider, PoTokenContext, PoTokenProvider, attach_to_player_body};

let provider = HttpMinterProvider::default();
if let Some(tok) = provider.fetch(PoTokenContext::Player, video_id).await? {
    attach_to_player_body(&mut player_body, &tok);
}
// player_body now contains:
// {
//   "context": { ... },
//   "videoId": "...",
//   "serviceIntegrityDimensions": {
//     "poToken": "<token>"    // <-- injected here
//   }
// }
```

### Stream URLs (GVS context)

Each adaptive stream URL returned by the player response has `&pot=<token>`
appended before it is handed to the player:

```rust
// In resolve(), when iterating adaptiveFormats[]:
use ytresolve::potoken::{HttpMinterProvider, PoTokenContext, PoTokenProvider, attach_to_stream_url};

let provider = HttpMinterProvider::default();
let gvs_token = provider.fetch(PoTokenContext::Gvs, video_id).await?;

let streams: Vec<StreamInfo> = raw_formats
    .iter()
    .map(|fmt| {
        let url = match &gvs_token {
            Some(tok) => attach_to_stream_url(&fmt.url, tok),
            None => fmt.url.clone(),
        };
        StreamInfo { url, itag: fmt.itag, mime_type: fmt.mime_type.clone(), bitrate: fmt.bitrate }
    })
    .collect();
```


## Honest Statement

**No PoToken is minted without a configured external provider.**

When `EEX_POT_PROVIDER_URL` is unset, `HttpMinterProvider::fetch` immediately
returns `Ok(None)` without making any network call.  The token attachment
helpers are never invoked, and stream URLs are returned without a `pot=`
parameter.

This means streams may be throttled or unavailable on IPs that YouTube has
flagged as bot traffic.  To get full-quality, unthrottled streams you MUST
run `bgutil-ytdlp-pot-provider` and set `EEX_POT_PROVIDER_URL`.
