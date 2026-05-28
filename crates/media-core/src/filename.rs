//! Filename → title/year or show/season/episode parsing. Pure and
//! exhaustively unit-testable.
//!
//! OWNER: agent A. Implement `parse_filename`. Handle the common real-world
//! shapes: `Movie Title (2021).mkv`, `Movie.Title.2021.1080p.BluRay.x264.mkv`,
//! `Show Name - S02E05 - Title.mkv`, `Show.Name.S02E05.720p.mkv`,
//! `Show 2x05.mkv`. Strip scene tags / resolution / codec noise. Return
//! `Unknown` when nothing matches rather than guessing wildly.

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

fn episode_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        // `S02E05` (case-insensitive) or `2x05`.
        Regex::new(r"(?i)s(\d{1,2})e(\d{1,3})|(\d{1,2})x(\d{1,3})").unwrap()
    })
}

fn year_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        // A 4-digit 1900–2099 year in parens or fenced by non-digits / ends.
        Regex::new(r"(?:^|[^0-9])((?:19|20)\d{2})(?:[^0-9]|$)").unwrap()
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

/// Parse a file name (with or without extension) into a [`ParsedName`].
pub fn parse_filename(name: &str) -> ParsedName {
    let stem = strip_extension(name);

    if let Some(m) = episode_re().captures(stem) {
        let marker = m.get(0).unwrap();
        // Either the SxxExx group (1,2) or the NxNN group (3,4) matched.
        let (season, episode) = if let (Some(s), Some(e)) = (m.get(1), m.get(2)) {
            (s.as_str().parse().ok(), e.as_str().parse().ok())
        } else {
            (
                m.get(3).and_then(|s| s.as_str().parse().ok()),
                m.get(4).and_then(|e| e.as_str().parse().ok()),
            )
        };

        if let (Some(season), Some(episode)) = (season, episode) {
            let show = clean(&stem[..marker.start()]);
            if !show.is_empty() {
                return ParsedName::Episode {
                    show,
                    season,
                    episode,
                };
            }
        }
    }

    // Movie: locate a plausible year and use the text before it as the title.
    if let Some(caps) = year_re().captures(stem) {
        let year_match = caps.get(1).unwrap();
        let year: i64 = year_match.as_str().parse().unwrap();
        let title = clean(&stem[..year_match.start()]);
        if !title.is_empty() {
            return ParsedName::Movie {
                title,
                year: Some(year),
            };
        }
    }

    let title = clean(stem);
    if title.is_empty() {
        ParsedName::Unknown
    } else {
        ParsedName::Movie { title, year: None }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        // A year-like token should not derail TV detection.
        assert_eq!(
            parse_filename("Show.Name.2024.S01E01.mkv"),
            ParsedName::Episode {
                show: "Show Name 2024".to_string(),
                season: 1,
                episode: 1,
            }
        );
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
}
