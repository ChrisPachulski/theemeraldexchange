//! The Claude side of the suggestions route (services/suggestionsPrompt.ts and
//! the recently-shown block): the cached system prompt, the per-request
//! blocks, the forced tool-use contract and the Messages API call with its
//! deadline and one 529/503 retry. Every builder ports byte for byte; the
//! prompt goldens hold them to the TS text.

use std::time::Duration;

use serde_json::{Value, json};

use super::{Item, LibItem, genre_counts};
use crate::AppState;
use crate::app::js_number;
use crate::routes::truthy;
use crate::stores::{IdTitle, Kind, sanitize_title};

/// Headroom over the 20-card strip for the validator's drops.
pub const CLAUDE_OVERFETCH: usize = 30;
/// 30 picks with reasons fit with room to spare.
const MAX_TOKENS: u32 = 4096;
/// Enough spread that refreshes differ, still in the "obvious yes" zone.
const TEMPERATURE: f64 = 0.7;
/// The likes store is unbounded; the paid prompt keeps the newest 500.
const LIKES_CAP: usize = 500;
const PRIORITY_CAP: usize = 30;
/// Below this the whole library already sits in the attended zone.
const PRIORITY_TRIGGER: usize = 60;
/// The per-attempt deadline; its text is what the usage log records.
pub const CLAUDE_TIMEOUT_MS: u64 = 20_000;
pub const ANTHROPIC_VERSION: &str = "2023-06-01";
const TOOL_NAME: &str = "submit_recommendations";

const SYSTEM_PROMPT: &str = r#"You are a media taste-matching agent for a household media server. Given the household's library and an explicit "never suggest" list, return ranked recommendations that match their existing taste — same era, tone, genre clusters, directorial sensibilities, and adjacent recommendations from beloved titles.

Rules:
- HARD RULE: Never recommend a title in the household's library. Library titles are listed in full below — every one of them. A server-side validator filters library matches by id and by normalized title (including subtitle base form) before the user sees the response, so recommending a library title costs the household one slot of the count contract AND one paid output token for nothing. Reach further into your knowledge instead.
- HARD RULE: Never recommend a title in the NEVER SUGGEST list. The complete list is shipped below — not a sample. Same cost as library overlap: the validator drops it, the user sees a shorter strip, and the household paid for tokens that produced no value. Avoid stylistically-near matches too (close remakes, alternate-name re-releases, the "season 2 of an existing rejected show").
- Mirror the genre distribution of the library. If 60% of the library is live-action drama, ~60% of your recommendations should be live-action drama. Do NOT over-index on any single genre cluster (e.g. don't return all-Animation or all-Anime just because those tags are present; they're a slice, not the whole picture).
- Each recommendation should have a clear analog in the library — name the closest matches in your reasoning, even if you don't return the reason field.
- Prefer well-regarded, mainstream-adjacent titles. Critical reception and audience love are signals; obscurity for its own sake is not.
- Modest variety across calls is fine, but recommendations should land in the "obvious yes" zone for someone who already loves what's in the library.
- Real, released titles only. No imaginary or future-dated releases.
- Be exact with titles and years so they can be looked up in TMDB.
- COUNT CONTRACT: always fill the requested number of picks. A short list or empty array is a system failure; if you can't find perfect matches, return your best attempts. A downstream validator filters overlaps with the library/never-list, so borderline picks are welcome — never return fewer than asked.

Output is consumed by code — return JSON only, no commentary."#;

const TOOL_DESCRIPTION: &str = r#"Submit the ranked list of recommended titles. Prefer titles from the CANDIDATE POOL when provided — they are already verified against the household library and NEVER SUGGEST list. Each entry MUST be a real, released title that is NOT in the household library and NOT on the NEVER SUGGEST list. For each pick, ALWAYS include a `reason`: a single short clause (≤90 chars) naming a specific library title or genre cluster — e.g. "neighbor of Severance", "for fans of Heat", "same prestige-crime tone as The Wire". The reason MUST reference something concrete in the household library or likes, NOT marketing copy. A reason is required for every pick that has a clear library analog (which is almost all of them — if you cannot ground a pick in the library, reconsider the pick)."#;

const REASON_DESCRIPTION: &str = r#"Required one-clause grounding (≤90 chars) naming a specific library title or cluster — e.g. "neighbor of Breaking Bad" or "same director as their Heat". This is what makes the recommendation trustworthy and personalised rather than generic. Only omit if the pick has zero connection to the library (rare)."#;

/// "Title (Year) — genre1, genre2": genres taste-match without many tokens.
fn format_library_item(it: &LibItem) -> String {
    let yr = match it.year {
        Some(y) if y != 0.0 && !y.is_nan() => format!(" ({})", js_number(y)),
        _ => String::new(),
    };
    let title = sanitize_title(it.title.as_deref().unwrap_or_default());
    let genres: Vec<String> = it
        .genres
        .iter()
        .map(|g| sanitize_title(g))
        .filter(|g| !g.is_empty())
        .take(3)
        .collect();
    let g = if genres.is_empty() {
        String::new()
    } else {
        format!(" \u{2014} {}", genres.join(", "))
    };
    format!("{title}{yr}{g}")
}

/// An untitled legacy row still tells Claude the id is gated.
fn render_entry_bullets<'a>(entries: impl IntoIterator<Item = &'a IdTitle>) -> String {
    entries
        .into_iter()
        .map(|e| {
            if e.title.is_empty() {
                format!("- [TMDB id {}]", e.id)
            } else {
                format!("- {}", e.title)
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// `["Drama 38%", ...]`, weighted by genre tags (a Drama+Crime title counts
/// in both).
pub fn compute_genre_distribution(library: &[LibItem], top_n: usize) -> Vec<String> {
    let counts = genre_counts(library);
    let total: usize = counts.iter().map(|(_, n)| n).sum();
    if total == 0 {
        return vec![];
    }
    counts
        .iter()
        .take(top_n)
        .map(|(g, n)| {
            let pct = (*n as f64 / total as f64 * 100.0).round() as i64;
            format!("{g} {pct}%")
        })
        .collect()
}

/// The cached block: rejections first (the most attended position after the
/// system prompt), then the library and its genre mix.
pub fn build_library_block(kind: Kind, library: &[LibItem], rejections: &[IdTitle]) -> String {
    let header = match kind {
        Kind::Movie => "MOVIES",
        Kind::Tv => "TV SHOWS",
    };
    let lib_lines = library
        .iter()
        .map(format_library_item)
        .collect::<Vec<_>>()
        .join("\n");
    let distribution = compute_genre_distribution(library, 6);
    let dist_line = if distribution.is_empty() {
        String::new()
    } else {
        format!(
            "\n\nTARGET GENRE MIX (match these proportions across your picks): {}",
            distribution.join(", ")
        )
    };
    let library_and_genres = format!(
        "Household {header} library ({} titles, do NOT suggest any of these):\n{lib_lines}{dist_line}",
        library.len()
    );
    if rejections.is_empty() {
        return library_and_genres;
    }
    let ordered: Vec<&IdTitle> = rejections
        .iter()
        .filter(|r| !r.title.is_empty())
        .chain(rejections.iter().filter(|r| r.title.is_empty()))
        .collect();
    format!(
        "NEVER SUGGEST \u{2014} the household has explicitly rejected every title below ({} total). \
         This is a hard contract: any recommendation matching this list will be silently dropped, the user will see a shorter strip, and the household's API budget will have paid for nothing. Every pick you submit MUST NOT appear here. Audit each pick against this list before calling the tool.\n\
         {}\n\n{library_and_genres}",
        ordered.len(),
        render_entry_bullets(ordered)
    )
}

/// Newest likes first (stored oldest-first), capped for the paid prompt.
pub fn build_user_likes_block(liked: &[IdTitle]) -> String {
    if liked.is_empty() {
        return String::new();
    }
    format!(
        "This user has explicitly LIKED the following \u{2014} recommend more in this vein \
         (strongest positive taste signal; items listed first are the MOST RECENTLY liked):\n{}",
        render_entry_bullets(liked.iter().rev().take(LIKES_CAP))
    )
}

/// The library titles most typical of the household's genres, hoisted after
/// the cache where a long library list loses attention. Score = sum of
/// 1/rank over a title's genres.
pub fn build_priority_taste_block(library: &[LibItem]) -> String {
    if library.len() < PRIORITY_TRIGGER {
        return String::new();
    }
    let counts = genre_counts(library);
    let rank: std::collections::HashMap<&str, f64> = counts
        .iter()
        .enumerate()
        .map(|(i, (g, _))| (g.as_str(), 1.0 / (i + 1) as f64))
        .collect();
    let mut scored: Vec<(&LibItem, f64)> = library
        .iter()
        .map(|it| {
            let mut score = 0.0;
            for g in &it.genres {
                score += rank.get(g.as_str()).copied().unwrap_or(0.0);
            }
            (it, score)
        })
        .collect();
    scored.sort_by(|a, b| b.1.total_cmp(&a.1));
    let top: Vec<&LibItem> = scored
        .into_iter()
        .take(PRIORITY_CAP)
        .map(|(it, _)| it)
        .collect();
    if top.is_empty() {
        return String::new();
    }
    let lines = top
        .iter()
        .map(|it| format!("- {}", format_library_item(it)))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "PRIORITY TASTE SIGNAL \u{2014} the {} library titles that most strongly anchor the household's taste cluster \
         (of {} total). Weight your recommendations toward titles a viewer of these would obviously want next:\n{lines}",
        top.len(),
        library.len()
    )
}

/// A numbered list Claude ranks from.
pub fn build_candidate_pool_block(candidates: &[Item]) -> String {
    if candidates.is_empty() {
        return String::new();
    }
    let lines = candidates
        .iter()
        .enumerate()
        .map(|(i, c)| match c.year {
            Some(y) if y != 0 => format!("{}. {} ({y})", i + 1, c.title),
            _ => format!("{}. {}", i + 1, c.title),
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "CANDIDATE POOL \u{2014} {} pre-vetted titles from your household's top genres (already screened: none are in your library or NEVER SUGGEST list). \
         RANK these by how well they match the household's taste. Pick your recommendations PRIMARILY from this list \u{2014} only reach outside it when the pool lacks good adjacents for a specific sub-genre the household clearly loves.\n\n{lines}",
        candidates.len()
    )
}

/// A soft "rotate, don't repeat" preference; empty with no history.
pub fn build_recently_shown_block(items: &[IdTitle]) -> String {
    if items.is_empty() {
        return String::new();
    }
    let bullets = items
        .iter()
        .map(|i| format!("- {}", i.title))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "RECENTLY SHOWN to this user (strong preference for fresh picks \u{2014} avoid these titles; \
         with the CANDIDATE POOL available there is always an alternative):\n{bullets}"
    )
}

/// 16 hex characters of per-request entropy outside the cached prefix.
pub fn refresh_salt() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..16].to_string()
}

fn user_ask(kind: Kind, n: usize, salt: &str, genre_hint: Option<&str>) -> String {
    let what = match kind {
        Kind::Movie => "movies",
        Kind::Tv => "TV shows",
    };
    let genre_clause = genre_hint.map_or_else(String::new, |h| {
        format!("\n\nGENRE FOCUS this call: {h}. The CANDIDATE POOL already reflects these genres; lean into them.")
    });
    format!(
        "[Request salt: {salt}]\n\n\
         Recommend exactly {n} {what} for this household by calling submit_recommendations. \
         Use the household's library and likes as taste signal; aim for a proportional mix across the library's genres, weighted toward explicitly liked titles. \
         \n\n\
         Before you submit, audit every pick: any title in the household library or the NEVER SUGGEST list must be replaced. A pick that matches either list is a wasted recommendation \u{2014} the user pays for the token and sees a shorter strip. \
         Return {n} picks, never fewer; if obvious matches are exhausted, reach into deeper-cut adjacent recommendations rather than repeating from those lists.\n\n\
         ROTATION QUOTA: at least 30% of your picks this round should be titles that did NOT appear in the RECENTLY SHOWN block (when one is present). The cached prefix tends to make refreshes look identical \u{2014} rotation is the only way the household sees new faces.{genre_clause}"
    )
}

fn submit_tool() -> Value {
    json!({
        "name": TOOL_NAME,
        "description": TOOL_DESCRIPTION,
        "input_schema": {
            "type": "object",
            "properties": {
                "picks": {
                    "type": "array",
                    "description": "Ordered list, most-likely-loved first.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "title": { "type": "string" },
                            "year": { "type": "integer" },
                            "reason": { "type": "string", "description": REASON_DESCRIPTION },
                        },
                        "required": ["title"],
                        "additionalProperties": false,
                    },
                },
            },
            "required": ["picks"],
            "additionalProperties": false,
        },
    })
}

/// The prompt blocks; the empty ones are left out of the system stack.
pub struct Blocks {
    pub library: String,
    pub priority: String,
    pub likes: String,
    pub recently_shown: String,
    pub pool: String,
}

impl Blocks {
    /// System prompt, then the cached library block, then the volatile ones
    /// (the pool last, read right before picking).
    fn system(&self, with_recent: bool) -> Value {
        let mut out = vec![
            json!({ "type": "text", "text": SYSTEM_PROMPT }),
            json!({ "type": "text", "text": self.library, "cache_control": { "type": "ephemeral" } }),
        ];
        let recent = if with_recent {
            self.recently_shown.as_str()
        } else {
            ""
        };
        for text in [
            self.priority.as_str(),
            self.likes.as_str(),
            recent,
            self.pool.as_str(),
        ] {
            if !text.is_empty() {
                out.push(json!({ "type": "text", "text": text }));
            }
        }
        Value::Array(out)
    }
}

fn request(model: &str, system: Value, messages: Value) -> Value {
    json!({
        "model": model,
        "max_tokens": MAX_TOKENS,
        "temperature": TEMPERATURE,
        "system": system,
        "tools": [submit_tool()],
        "tool_choice": { "type": "tool", "name": TOOL_NAME, "disable_parallel_tool_use": true },
        "messages": messages,
    })
}

pub fn initial_body(model: &str, kind: Kind, b: &Blocks, salt: &str, hint: Option<&str>) -> Value {
    let ask = user_ask(kind, CLAUDE_OVERFETCH, salt, hint);
    request(
        model,
        b.system(true),
        json!([{ "role": "user", "content": ask }]),
    )
}

/// The retry replays the first exchange and answers its tool call with the
/// validator's rejections. It drops the recently-shown block: this is when
/// Claude needs the most room.
// The TS callClaudeRetry's own parameters.
#[allow(clippy::too_many_arguments)]
pub fn retry_body(
    model: &str,
    kind: Kind,
    b: &Blocks,
    prior: &ToolUse,
    rejected: &[(String, String)],
    n_needed: usize,
    salt: &str,
    hint: Option<&str>,
) -> Value {
    let summary = rejected
        .iter()
        .take(15)
        .map(|(title, reason)| format!("  - \"{title}\" \u{2014} {reason}"))
        .collect::<Vec<_>>()
        .join("\n");
    let tool_result = format!(
        "{} of your picks were rejected by the household-safety validator:\n{summary}\n\n\
         Call submit_recommendations again with {n_needed} REPLACEMENT picks that don't conflict.",
        rejected.len()
    );
    let ask = user_ask(kind, CLAUDE_OVERFETCH, salt, hint);
    request(
        model,
        b.system(false),
        json!([
            { "role": "user", "content": ask },
            { "role": "assistant", "content": [
                { "type": "tool_use", "id": prior.id, "name": prior.name, "input": prior.input },
            ] },
            { "role": "user", "content": [
                { "type": "tool_result", "tool_use_id": prior.id, "content": tool_result },
            ] },
        ]),
    )
}

// --- the Messages API ------------------------------------------------------------------

/// One pick as Claude sent it: `year` and `reason` stay raw (Null when
/// absent), since the validator reads them with JS semantics.
#[derive(Clone, Debug)]
pub struct Pick {
    pub title: String,
    pub year: Value,
    pub reason: Value,
}

/// The tool call, echoed back verbatim on the retry.
#[derive(Clone, Debug)]
pub struct ToolUse {
    pub id: Value,
    pub name: Value,
    pub input: Value,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Usage {
    pub input: Option<u64>,
    pub output: Option<u64>,
    pub cache_creation: Option<u64>,
    pub cache_read: Option<u64>,
}

impl Usage {
    /// Token counts add up (0 when both are absent); a cache total of 0
    /// reads as absent.
    pub fn merge(self, b: Usage) -> Usage {
        let sum = |x: Option<u64>, y: Option<u64>| x.unwrap_or(0) + y.unwrap_or(0);
        let nonzero = |n: u64| (n != 0).then_some(n);
        Usage {
            input: Some(sum(self.input, b.input)),
            output: Some(sum(self.output, b.output)),
            cache_creation: nonzero(sum(self.cache_creation, b.cache_creation)),
            cache_read: nonzero(sum(self.cache_read, b.cache_read)),
        }
    }
}

#[derive(Clone, Debug)]
pub struct ClaudeResponse {
    pub tool_use: Option<ToolUse>,
    pub picks: Vec<Pick>,
    pub usage: Usage,
    /// stop_reason max_tokens: the picks are cut short.
    pub truncated: bool,
}

#[derive(Clone, Debug)]
pub struct ClaudeError {
    pub message: String,
    /// The API's status; None when it never answered.
    pub status: Option<u16>,
}

/// One retry, 3 s later, for the documented transient states (529
/// Overloaded, 503); anything else, or a timeout, fails at once.
pub async fn call(st: &AppState, key: &str, body: &Value) -> Result<ClaudeResponse, ClaudeError> {
    let t = st.suggestions.timings;
    let attempt = || async {
        tokio::time::timeout(t.claude_timeout, send(st, key, body))
            .await
            .unwrap_or_else(|_| {
                Err(ClaudeError {
                    message: format!("Claude request exceeded {CLAUDE_TIMEOUT_MS}ms"),
                    status: None,
                })
            })
    };
    match attempt().await {
        Err(e) if matches!(e.status, Some(529 | 503)) => {
            tracing::warn!(
                event = "suggestions",
                status = e.status,
                retry_delay_ms = t.anthropic_retry_delay.as_millis() as u64,
                "Anthropic transient error \u{2014} retrying"
            );
            tokio::time::sleep(t.anthropic_retry_delay).await;
            attempt().await
        }
        other => other,
    }
}

async fn send(st: &AppState, key: &str, body: &Value) -> Result<ClaudeResponse, ClaudeError> {
    let fail = |message: String| ClaudeError {
        message,
        status: None,
    };
    let res = st
        .upstream
        .client()
        .post(format!("{}/v1/messages", st.config.ext.anthropic_base))
        .header("x-api-key", key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .json(body)
        .send()
        .await
        .map_err(|e| fail(e.without_url().to_string()))?;
    let status = res.status().as_u16();
    let text = res
        .text()
        .await
        .map_err(|e| fail(e.without_url().to_string()))?;
    if !(200..300).contains(&status) {
        return Err(ClaudeError {
            message: status_message(status, &text),
            status: Some(status),
        });
    }
    let v: Value = serde_json::from_str(&text).map_err(|e| fail(e.to_string()))?;
    read_tool_use(&v).ok_or_else(|| fail("Claude response has no content array".into()))
}

/// The SDK's error text: `<status> <body.message | body JSON | body text>`.
/// The JSON is the body as sent (the SDK re-serialized it compactly).
fn status_message(status: u16, text: &str) -> String {
    let msg = match serde_json::from_str::<Value>(text) {
        Ok(v) if truthy(&v) => match v.get("message") {
            Some(Value::String(s)) if !s.is_empty() => s.clone(),
            Some(m) if truthy(m) => m.to_string(),
            _ => text.trim().to_string(),
        },
        _ => text.to_string(),
    };
    if msg.is_empty() {
        format!("{status} status code (no body)")
    } else {
        format!("{status} {msg}")
    }
}

/// The first tool_use block's picks (string titles only). No block, or a
/// max_tokens cut, is logged; a missing content array is None.
pub fn read_tool_use(resp: &Value) -> Option<ClaudeResponse> {
    let u = &resp["usage"];
    let usage = Usage {
        input: u["input_tokens"].as_u64(),
        output: u["output_tokens"].as_u64(),
        cache_creation: u["cache_creation_input_tokens"].as_u64(),
        cache_read: u["cache_read_input_tokens"].as_u64(),
    };
    let content = resp.get("content")?.as_array()?;
    let Some(tu) = content.iter().find(|b| b["type"] == "tool_use") else {
        let types: Vec<String> = content
            .iter()
            .map(|b| crate::tmdb::js_string(&b["type"]))
            .collect();
        tracing::error!(event = "suggestions", content_types = %types.join(","), stop_reason = %resp["stop_reason"], "Claude returned no tool_use block");
        return Some(ClaudeResponse {
            tool_use: None,
            picks: vec![],
            usage,
            truncated: false,
        });
    };
    let truncated = resp["stop_reason"] == "max_tokens";
    if truncated {
        tracing::error!(
            event = "suggestions",
            "tool_use truncated by max_tokens \u{2014} picks list will be incomplete or empty; raise max_tokens or shrink CLAUDE_OVERFETCH"
        );
    }
    let input = tu.get("input").cloned().unwrap_or(Value::Null);
    let raw = input["picks"].as_array().map_or(&[][..], Vec::as_slice);
    let picks: Vec<Pick> = raw
        .iter()
        .filter_map(|p| {
            let title = p.as_object()?.get("title")?.as_str()?;
            (!auth::js_trim(title).is_empty()).then(|| Pick {
                title: title.to_string(),
                year: p.get("year").cloned().unwrap_or(Value::Null),
                reason: p.get("reason").cloned().unwrap_or(Value::Null),
            })
        })
        .collect();
    if !raw.is_empty() && picks.len() < raw.len() {
        tracing::warn!(
            event = "suggestions",
            filtered = raw.len() - picks.len(),
            received = raw.len(),
            "readToolUse dropped malformed picks (missing/non-string title)"
        );
    }
    Some(ClaudeResponse {
        tool_use: Some(ToolUse {
            id: tu.get("id").cloned().unwrap_or(Value::Null),
            name: tu.get("name").cloned().unwrap_or(Value::Null),
            input,
        }),
        picks,
        usage,
        truncated,
    })
}

/// How long the transient retry waits.
pub const ANTHROPIC_RETRY_DELAY: Duration = Duration::from_secs(3);
