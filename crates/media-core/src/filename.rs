//! Filename → title/year or show/season/episode parsing. Pure and
//! exhaustively unit-testable.
//!
//! Handles the common real-world shapes: `Movie Title (2021).mkv`,
//! `Movie.Title.2021.1080p.BluRay.x264.mkv`, `Show Name - S02E05 - Title.mkv`,
//! `Show.Name.S02E05.720p.mkv`, `Show 2x05.mkv`. Strips scene/quality/codec
//! noise via [`strip_tags`], extracts a movie year as the *last* plausible
//! 1900–2099 token (so a leading-numeric title like `1917` is not eaten),
//! exposes a canonical [`normalize_show_name`] dedup key, and is library-root
//! aware via [`classify`]: a file under a `Shows` root never becomes a movie
//! and a file under a `Movies` root never becomes an episode. Returns
//! `Unknown` rather than guessing wildly.

use std::path::Path;
use std::sync::OnceLock;

use regex::Regex;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParsedName {
    Movie {
        title: String,
        year: Option<i64>,
    },
    Episode {
        show: String,
        season: i64,
        episode: i64,
    },
    Unknown,
}

/// The kind of library root a file was found under. The root is authoritative:
/// classification trusts it over a fragile filename regex.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RootKind {
    /// A movies/films root: never yields an episode.
    Movies,
    /// A tv/shows/series root: never yields a movie.
    Shows,
    /// Unknown root: fall back to pure filename heuristics.
    Auto,
}

fn episode_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        // `S02E05` (case-insensitive) or `2x05`.
        Regex::new(r"(?i)s(\d{1,2})e(\d{1,3})|(\d{1,2})x(\d{1,3})").unwrap()
    })
}

/// Case-insensitive matcher for the first scene/quality/codec/audio/HDR noise
/// token. Everything from that token to end-of-string is dropped.
fn noise_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?ix)
            (?:^|\s)                     # token boundary
            (?:
              # resolution
              \d{3,4}[pi] | 2160p | 4k | uhd
              # source
              | blu-?ray | brrip | bdrip | web-?rip | web-?dl | webdl | hdtv | dvdrip | remux
              # codec
              | x\.?26[45] | h\.?26[45] | hevc | avc | av1 | xvid | divx | 10bit
              # audio
              | true-?hd | atmos | dts(?:-?hd)? | ddp?5?\.?1 | ac3 | e-?ac3 | aac | flac
              | 7\s?1 | 5\s?1 | 2\s?0
              # HDR
              | dovi | dv | hdr10\+? | hdr | sdr
              # misc release flags
              | proper | repack | internal | extended | uncut | remastered | imax
            )
            (?:\b|$)
            ",
        )
        .unwrap()
    })
}

/// Strip a trailing file extension (e.g. `.mkv`) from a name, if present.
fn strip_extension(name: &str) -> &str {
    match name.rfind('.') {
        // Treat as an extension only when it is short and alphanumeric, so we
        // don't lop off part of a title like "1.5" or a trailing tag.
        Some(idx) if idx > 0 => {
            let ext = &name[idx + 1..];
            if !ext.is_empty() && ext.len() <= 4 && ext.chars().all(|c| c.is_ascii_alphanumeric()) {
                &name[..idx]
            } else {
                name
            }
        }
        _ => name,
    }
}

/// Replace separator punctuation with spaces, collapse whitespace, trim, and
/// drop dangling bracket punctuation left over from year/marker removal.
fn clean(text: &str) -> String {
    let replaced: String = text
        .chars()
        .map(|c| match c {
            '.' | '_' | '-' => ' ',
            other => other,
        })
        .collect();
    let joined = replaced.split_whitespace().collect::<Vec<_>>().join(" ");
    joined
        .trim_matches(|c: char| matches!(c, '(' | ')' | '[' | ']' | '{' | '}'))
        .trim()
        .to_string()
}

/// Drop quality/release/codec noise: everything from the first noise token to
/// the end of the (already separator-cleaned, space-delimited) string. Applied
/// to both movie titles and show names. Operates on a cleaned string so a
/// dotted release name has already become spaces.
fn strip_tags(cleaned: &str) -> String {
    let prefixed = format!(" {cleaned}");
    if let Some(m) = noise_re().find(&prefixed) {
        // m.start() points at the leading boundary (space or start). Cut there.
        let cut = m.start();
        prefixed[..cut].trim().to_string()
    } else {
        cleaned.trim().to_string()
    }
}

/// Strip a single trailing 4-digit 1900–2099 year token from a cleaned string.
fn strip_trailing_year(cleaned: &str) -> String {
    let trimmed = cleaned.trim_end();
    if let Some(last) = trimmed.rsplit(' ').next()
        && last.len() == 4
        && last.chars().all(|c| c.is_ascii_digit())
        && let Ok(y) = last.parse::<i64>()
        && (1900..=2099).contains(&y)
    {
        let cut = trimmed.len() - last.len();
        return trimmed[..cut].trim_end().to_string();
    }
    trimmed.to_string()
}

/// Canonical dedup key for a show: lowercase, separators→space, strip a single
/// trailing year, strip quality/release tokens, collapse whitespace. Two
/// filename variants of the same series (`Adventure Time` vs
/// `Adventure Time 2008` vs `adventure.time.2008.1080p.bluray.x265`) map to the
/// same key (`adventure time`).
pub fn normalize_show_name(raw: &str) -> String {
    let cleaned = clean(raw).to_lowercase();
    let no_tags = strip_tags(&cleaned);
    let no_year = strip_trailing_year(&no_tags);
    no_year.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Extract `(season, episode)` from a captured episode marker.
fn marker_to_se(caps: &regex::Captures) -> Option<(i64, i64)> {
    if let (Some(s), Some(e)) = (caps.get(1), caps.get(2)) {
        Some((s.as_str().parse().ok()?, e.as_str().parse().ok()?))
    } else {
        let s = caps.get(3)?.as_str().parse().ok()?;
        let e = caps.get(4)?.as_str().parse().ok()?;
        Some((s, e))
    }
}

/// Try to parse `stem` as an episode. Returns the show display name (cleaned,
/// tag-stripped) plus season/episode.
fn try_episode(stem: &str) -> Option<(String, i64, i64)> {
    let caps = episode_re().captures(stem)?;
    let marker = caps.get(0).unwrap();
    let (season, episode) = marker_to_se(&caps)?;
    let show = strip_tags(&clean(&stem[..marker.start()]));
    if show.is_empty() {
        return None;
    }
    Some((show, season, episode))
}

/// Try to parse `stem` as a movie: locate a plausible year and use the cleaned
/// text before it as the title, picking the *last* 1900–2099 token whose
/// preceding title is non-empty (so a leading numeric title like `1917` is not
/// consumed as the year). Falls back to a year-less movie when no qualifying
/// year exists.
fn parse_movie(stem: &str) -> ParsedName {
    // Scan every 4-digit run with non-digit boundaries on both sides. Using
    // byte positions directly (rather than `captures_iter`, which cannot match
    // two space-separated years like "1917 2019" because the first match
    // consumes the shared boundary) lets adjacent year tokens both be seen.
    // All candidate checks happen on raw bytes; `stem` is only sliced once the
    // run is confirmed all-ASCII-digit, which guarantees `i` and `i + 4` are
    // char boundaries — a `&stem[i..i + 4]` probe at an arbitrary byte offset
    // panics on non-ASCII stems like "Amélie (2001)".
    let bytes = stem.as_bytes();
    let mut chosen: Option<(usize, i64)> = None;
    let mut i = 0;
    while i + 4 <= bytes.len() {
        let before_ok = i == 0 || !bytes[i - 1].is_ascii_digit();
        let after_ok = i + 4 == bytes.len() || !bytes[i + 4].is_ascii_digit();
        let run = &bytes[i..i + 4];
        let is_year = before_ok
            && after_ok
            && run.iter().all(u8::is_ascii_digit)
            && (run.starts_with(b"19") || run.starts_with(b"20"));
        if is_year {
            let year: i64 = stem[i..i + 4].parse().unwrap();
            let preceding = strip_tags(&clean(&stem[..i]));
            if !preceding.is_empty() {
                chosen = Some((i, year));
            }
            i += 4;
        } else {
            i += 1;
        }
    }

    if let Some((start, year)) = chosen {
        let title = strip_tags(&clean(&stem[..start]));
        if !title.is_empty() {
            return ParsedName::Movie {
                title,
                year: Some(year),
            };
        }
    }

    let title = strip_tags(&clean(stem));
    if title.is_empty() {
        ParsedName::Unknown
    } else {
        ParsedName::Movie { title, year: None }
    }
}

/// `true` when the *reversed* stem matches an episode marker but the forward
/// stem does not — i.e. the basename was reversed upstream (the live
/// `010E70S yhcranA fo snoS` corruption). Surfaces the upstream bug instead of
/// silently classifying the garbage as a movie.
fn looks_reversed(stem: &str) -> bool {
    if episode_re().is_match(stem) {
        return false;
    }
    let reversed: String = stem.chars().rev().collect();
    episode_re().is_match(&reversed)
}

/// Parse a file name (with or without extension) into a [`ParsedName`] using
/// pure filename heuristics (no library-root authority).
pub fn parse_filename(name: &str) -> ParsedName {
    let stem = strip_extension(name);

    if looks_reversed(stem) {
        tracing::warn!("reversed/corrupt media basename, refusing to classify: {name:?}");
        return ParsedName::Unknown;
    }

    if let Some((show, season, episode)) = try_episode(stem) {
        return ParsedName::Episode {
            show,
            season,
            episode,
        };
    }

    parse_movie(stem)
}

/// Derive a show display name from a file's parent directory, falling back to
/// the grandparent when the immediate parent is a `Season NN` folder.
fn show_from_parent(path: &Path) -> Option<String> {
    let parent = path.parent()?;
    let name = parent.file_name()?.to_str()?;
    let cleaned = strip_tags(&clean(name));
    let looks_seasonish = {
        let lower = cleaned.to_lowercase();
        lower.starts_with("season") || lower.starts_with("series") || lower.starts_with("specials")
    };
    if cleaned.is_empty() || looks_seasonish {
        let gp = parent.parent()?;
        let gname = gp.file_name()?.to_str()?;
        let g = strip_tags(&clean(gname));
        if g.is_empty() { None } else { Some(g) }
    } else {
        Some(cleaned)
    }
}

/// Root-aware classification. The library root is authoritative for kind:
/// - `Shows`: parse `SxxExx`/`NxNN`; on a regex miss derive the show from the
///   parent folder and emit an `Episode` (season/episode 0 when unknown), or
///   `Unknown` — but NEVER a `Movie`.
/// - `Movies`: emit `Movie{title,year}` and NEVER an `Episode`, even when a
///   spurious `SxxExx` is present in the name.
/// - `Auto`: identical to [`parse_filename`].
pub fn classify(kind: RootKind, path: &Path, name: &str) -> ParsedName {
    let stem = strip_extension(name);

    match kind {
        RootKind::Auto => parse_filename(name),
        RootKind::Movies => {
            if looks_reversed(stem) {
                tracing::warn!("reversed/corrupt movie basename: {name:?}");
                return ParsedName::Unknown;
            }
            parse_movie(stem)
        }
        RootKind::Shows => {
            if looks_reversed(stem) {
                tracing::warn!("reversed/corrupt show basename: {name:?}");
                return ParsedName::Unknown;
            }
            if let Some((show, season, episode)) = try_episode(stem) {
                return ParsedName::Episode {
                    show,
                    season,
                    episode,
                };
            }
            // Regex miss under a Shows root: trust the root, derive the show
            // from the folder, emit an Episode with unknown season/episode
            // rather than ever producing a movies row.
            match show_from_parent(path) {
                Some(show) => ParsedName::Episode {
                    show,
                    season: 0,
                    episode: 0,
                },
                None => ParsedName::Unknown,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn table_driven_cases() {
        let cases: &[(&str, ParsedName)] = &[
            (
                "Movie Title (2021).mkv",
                ParsedName::Movie {
                    title: "Movie Title".to_string(),
                    year: Some(2021),
                },
            ),
            (
                "Movie.Title.2021.1080p.BluRay.x264.mkv",
                ParsedName::Movie {
                    title: "Movie Title".to_string(),
                    year: Some(2021),
                },
            ),
            (
                "Show Name - S02E05 - Ep Title.mkv",
                ParsedName::Episode {
                    show: "Show Name".to_string(),
                    season: 2,
                    episode: 5,
                },
            ),
            (
                "Show.Name.S02E05.720p.mkv",
                ParsedName::Episode {
                    show: "Show Name".to_string(),
                    season: 2,
                    episode: 5,
                },
            ),
            (
                "Show 2x05.mkv",
                ParsedName::Episode {
                    show: "Show".to_string(),
                    season: 2,
                    episode: 5,
                },
            ),
            (
                "Plain Title.mp4",
                ParsedName::Movie {
                    title: "Plain Title".to_string(),
                    year: None,
                },
            ),
            ("", ParsedName::Unknown),
            ("   ", ParsedName::Unknown),
            ("...___---", ParsedName::Unknown),
        ];

        for (input, expected) in cases {
            assert_eq!(parse_filename(input), *expected, "input: {input:?}");
        }
    }

    #[test]
    fn lowercase_episode_marker() {
        assert_eq!(
            parse_filename("the.expanse.s01e03.mkv"),
            ParsedName::Episode {
                show: "the expanse".to_string(),
                season: 1,
                episode: 3,
            }
        );
    }

    #[test]
    fn episode_takes_priority_over_year() {
        // A year-like token should not derail TV detection, and the normalized
        // dedup key must be identical with or without the embedded year.
        let with_year = parse_filename("Show.Name.2024.S01E01.mkv");
        let without_year = parse_filename("Show.Name.S01E01.mkv");
        match (&with_year, &without_year) {
            (ParsedName::Episode { show: a, .. }, ParsedName::Episode { show: b, .. }) => {
                assert_eq!(normalize_show_name(a), normalize_show_name(b));
                assert_eq!(normalize_show_name(a), "show name");
            }
            other => panic!("expected two episodes, got {other:?}"),
        }
        assert!(matches!(
            with_year,
            ParsedName::Episode {
                season: 1,
                episode: 1,
                ..
            }
        ));
    }

    #[test]
    fn movie_without_extension() {
        assert_eq!(
            parse_filename("Some Movie (1999)"),
            ParsedName::Movie {
                title: "Some Movie".to_string(),
                year: Some(1999),
            }
        );
    }

    #[test]
    fn year_out_of_range_treated_as_plain_title() {
        // 1850 is outside 1900–2099, so no year is extracted.
        assert_eq!(
            parse_filename("Year 1850 Drama.mkv"),
            ParsedName::Movie {
                title: "Year 1850 Drama".to_string(),
                year: None,
            }
        );
    }

    // ── New invariants ────────────────────────────────────────────────────

    #[test]
    fn parse_never_returns_the_reversed_input() {
        // Property: the cleaned reversal of the input must never appear as the
        // emitted title/show. Locks the invariant the stale binary violated.
        let inputs = [
            "Sons of Anarchy S07E010.mkv",
            "Movie.Title.2021.1080p.BluRay.x264.mkv",
            "The Wire - S02E05.mkv",
            "Adventure Time 2008 S01E01.mkv",
        ];
        for input in inputs {
            let stem = strip_extension(input);
            let reversed: String = clean(stem).chars().rev().collect();
            let parsed = parse_filename(input);
            let emitted = match &parsed {
                ParsedName::Movie { title, .. } => title.clone(),
                ParsedName::Episode { show, .. } => show.clone(),
                ParsedName::Unknown => String::new(),
            };
            assert_ne!(emitted, reversed, "input: {input:?}");
        }
    }

    #[test]
    fn three_digit_episode_is_episode_not_movie() {
        assert_eq!(
            parse_filename("Sons.of.Anarchy.S07E010.mkv"),
            ParsedName::Episode {
                show: "Sons of Anarchy".to_string(),
                season: 7,
                episode: 10,
            }
        );
    }

    #[test]
    fn leading_numeric_title_keeps_its_name_and_year() {
        // The '1917' title token must NOT be eaten as the year; '2019' wins,
        // and all the quality/audio/HDR/codec/release tokens are stripped.
        assert_eq!(
            parse_filename("1917 2019 UHD BluRay 2160p TrueHD 7 1 Atmos DV HDR10 AV1 RandH.mkv"),
            ParsedName::Movie {
                title: "1917".to_string(),
                year: Some(2019),
            }
        );
    }

    #[test]
    fn non_ascii_titles_parse_without_panicking() {
        // Regression: the year scan advanced a raw byte index and sliced
        // `&stem[i..i + 4]`, panicking on any non-char-boundary offset — one
        // accented/CJK/emoji filename killed the whole scan task.
        assert_eq!(
            parse_filename("Amélie (2001).mkv"),
            ParsedName::Movie {
                title: "Amélie".to_string(),
                year: Some(2001),
            }
        );
        assert_eq!(
            parse_filename("Léon The Professional 1994.mkv"),
            ParsedName::Movie {
                title: "Léon The Professional".to_string(),
                year: Some(1994),
            }
        );
        assert_eq!(
            parse_filename("千と千尋の神隠し (2001).mkv"),
            ParsedName::Movie {
                title: "千と千尋の神隠し".to_string(),
                year: Some(2001),
            }
        );
        assert_eq!(
            parse_filename("🎬 Movie Night 2020.mkv"),
            ParsedName::Movie {
                title: "🎬 Movie Night".to_string(),
                year: Some(2020),
            }
        );
        // Year-less non-ASCII drives the scan loop across every (multi-byte)
        // char position to end-of-string.
        assert_eq!(
            parse_filename("こんにちは.mkv"),
            ParsedName::Movie {
                title: "こんにちは".to_string(),
                year: None,
            }
        );
    }

    #[test]
    fn classify_handles_non_ascii_under_both_roots() {
        let movie_path = PathBuf::from("/media/Movies/Amélie (2001).mkv");
        assert_eq!(
            classify(RootKind::Movies, &movie_path, "Amélie (2001).mkv"),
            ParsedName::Movie {
                title: "Amélie".to_string(),
                year: Some(2001),
            }
        );
        let show_path = PathBuf::from("/media/tv_shows/Élite/Élite S01E01.mkv");
        assert_eq!(
            classify(RootKind::Shows, &show_path, "Élite S01E01.mkv"),
            ParsedName::Episode {
                show: "Élite".to_string(),
                season: 1,
                episode: 1,
            }
        );
    }

    #[test]
    fn quality_tokens_are_stripped_from_movie_titles() {
        assert_eq!(
            parse_filename("Heat.1995.1080p.BluRay.x265.HEVC.DTS.mkv"),
            ParsedName::Movie {
                title: "Heat".to_string(),
                year: Some(1995),
            }
        );
    }

    #[test]
    fn normalize_collapses_year_and_quality_variants() {
        assert_eq!(normalize_show_name("Adventure Time"), "adventure time");
        assert_eq!(normalize_show_name("Adventure Time 2008"), "adventure time");
        assert_eq!(
            normalize_show_name("adventure.time.2008.1080p.bluray.x265"),
            "adventure time"
        );
        assert_eq!(normalize_show_name("Altered Carbon"), "altered carbon");
        assert_eq!(normalize_show_name("Altered Carbon 2018"), "altered carbon");
    }

    #[test]
    fn normalize_preserves_interior_year() {
        // Only a TRAILING year is stripped; an interior one stays.
        assert_eq!(
            normalize_show_name("2001 A Space Odyssey"),
            "2001 a space odyssey"
        );
    }

    #[test]
    fn classify_shows_root_reversed_is_unknown_never_movie() {
        let path = PathBuf::from("/media/tv_shows/Sons of Anarchy/010E70S yhcranA fo snoS.mkv");
        let parsed = classify(RootKind::Shows, &path, "010E70S yhcranA fo snoS.mkv");
        assert_eq!(parsed, ParsedName::Unknown);
        assert!(!matches!(parsed, ParsedName::Movie { .. }));
    }

    #[test]
    fn classify_shows_root_derives_show_from_folder_on_miss() {
        let path = PathBuf::from("/media/tv_shows/Adventure Time/random clip.mkv");
        let parsed = classify(RootKind::Shows, &path, "random clip.mkv");
        match parsed {
            ParsedName::Episode { show, .. } => {
                assert_eq!(normalize_show_name(&show), "adventure time");
            }
            other => panic!("expected Episode from Shows root, got {other:?}"),
        }
    }

    #[test]
    fn classify_shows_root_never_returns_movie() {
        let path = PathBuf::from("/media/tv_shows/Foo/Foo S01E02.mkv");
        let parsed = classify(RootKind::Shows, &path, "Foo S01E02.mkv");
        assert!(matches!(parsed, ParsedName::Episode { .. }));
    }

    #[test]
    fn classify_movies_root_never_returns_episode() {
        // Even with a spurious SxxExx, a Movies root yields a Movie.
        let path = PathBuf::from("/media/Movies/Weird S01E01 2019.mkv");
        let parsed = classify(RootKind::Movies, &path, "Weird S01E01 2019.mkv");
        assert!(matches!(parsed, ParsedName::Movie { .. }), "got {parsed:?}");
    }

    #[test]
    fn classify_movies_root_extracts_year() {
        let path = PathBuf::from("/media/Movies/Heat 1995.mkv");
        assert_eq!(
            classify(RootKind::Movies, &path, "Heat 1995.mkv"),
            ParsedName::Movie {
                title: "Heat".to_string(),
                year: Some(1995),
            }
        );
    }
}
