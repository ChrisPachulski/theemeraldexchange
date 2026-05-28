//! Filename → title/year or show/season/episode parsing. Pure and
//! exhaustively unit-testable.
//!
//! OWNER: agent A. Implement `parse_filename`. Handle the common real-world
//! shapes: `Movie Title (2021).mkv`, `Movie.Title.2021.1080p.BluRay.x264.mkv`,
//! `Show Name - S02E05 - Title.mkv`, `Show.Name.S02E05.720p.mkv`,
//! `Show 2x05.mkv`. Strip scene tags / resolution / codec noise. Return
//! `Unknown` when nothing matches rather than guessing wildly.

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParsedName {
    Movie { title: String, year: Option<i64> },
    Episode { show: String, season: i64, episode: i64 },
    Unknown,
}

/// Parse a file name (with or without extension) into a [`ParsedName`].
pub fn parse_filename(_name: &str) -> ParsedName {
    todo!("AGENT A: implement filename parsing for movies and TV episodes")
}
