//! Streaming XMLTV parser behind `streamXmltv` (server/services/iptvEpg.ts).
//!
//! A port of the sax + regex-sniffer pipeline it replaced, row for row:
//! programmes come from an XML tokenizer driven by the same state machine the
//! sax handlers ran (last <title>/<desc> wins, sax's trim + whitespace
//! collapse, Date.UTC field overflow), and channel defs from the same regex
//! sniffer over the raw text (why: the streamXmltv doc comment). Malformed
//! XML (a bare '&', an unknown entity) fails the parse, as sax's error event
//! did.
//!
//! The caller pushes raw feed bytes in whatever chunks the network delivers;
//! gzip is detected from the first two bytes. Text is parsed up to the last
//! `</programme>` or `</channel>` seen, so a text node is never split across
//! two parses.

use std::collections::HashSet;
use std::io::Write;
use std::sync::{Arc, LazyLock};

use flate2::write::MultiGzDecoder;
use quick_xml::Reader;
use quick_xml::escape::{resolve_predefined_entity, unescape};
use quick_xml::events::{BytesRef, BytesStart, Event};
use regex::bytes::Regex;
use serde::Serialize;

// Same ceiling as the TS sniffer: only a <channel tag that never closes trips it.
const SNIFF_BUF_MAX: usize = 1_000_000;
// A real programme is a few KB; text with no closing tag this long is hostile.
const UNPARSED_MAX: usize = 64 * 1024 * 1024;
// Text is parsed in batches this large so it can be split across threads.
const PARALLEL_BATCH: usize = 8 * 1024 * 1024;
// ponytail: fixed cap; the NAS has 6 threads and shares them with Plex.
const MAX_THREADS: usize = 4;

static CHANNEL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?s-u)<channel\b[^>]*\bid="([^"]+)"[^>]*>(.*?)</channel>"#).unwrap()
});
static DISPLAY_NAME_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?-u)<display-name[^>]*>([^<]+)</display-name>").unwrap());

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Programme {
    pub channel_id: String,
    pub start_utc: String,
    pub stop_utc: String,
    pub title: Option<String>,
    pub description: Option<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct ChannelDef {
    pub id: String,
    pub names: Vec<String>,
}

#[derive(Serialize, Default, Debug)]
pub struct Batch {
    pub programmes: Vec<Programme>,
    pub channels: Vec<ChannelDef>,
}

enum Input {
    Head(Vec<u8>),
    Plain,
    Gzip(Box<MultiGzDecoder<Vec<u8>>>),
}

pub struct Parser {
    input: Input,
    sniff: Option<Vec<u8>>,
    unparsed: Vec<u8>,
    first_fragment: bool,
    machine: Machine,
}

/// The sax handlers' state: the open programme and the title/desc text.
#[derive(Default, Clone)]
struct Machine {
    cur: Option<Programme>,
    in_title: bool,
    in_desc: bool,
    text: String,
    // Normalized channel ids to keep; None keeps every channel.
    keep: Option<Arc<HashSet<String>>>,
}

impl Parser {
    pub fn new(sniff_channels: bool) -> Self {
        Parser {
            input: Input::Head(Vec::new()),
            sniff: sniff_channels.then(Vec::new),
            unparsed: Vec::new(),
            first_fragment: true,
            machine: Machine::default(),
        }
    }

    pub fn push(&mut self, chunk: &[u8]) -> Result<Batch, String> {
        let mut batch = Batch::default();
        match &mut self.input {
            Input::Head(head) => {
                head.extend_from_slice(chunk);
                if head.len() < 2 {
                    return Ok(batch);
                }
                let head = std::mem::take(head);
                if head[..2] == [0x1f, 0x8b] {
                    self.input = Input::Gzip(Box::new(MultiGzDecoder::new(Vec::new())));
                    let bytes = self.gunzip(&head)?;
                    self.feed(&bytes, false, &mut batch)?;
                } else {
                    self.input = Input::Plain;
                    self.feed(&head, false, &mut batch)?;
                }
            }
            // Plain input is fed straight from the caller's buffer.
            Input::Plain => self.feed(chunk, false, &mut batch)?,
            Input::Gzip(_) => {
                let bytes = self.gunzip(chunk)?;
                self.feed(&bytes, false, &mut batch)?;
            }
        }
        Ok(batch)
    }

    /// From now on, emit only programmes on these (normalized) channel ids.
    /// Text already parsed is unaffected; the rest is still checked as XML.
    pub fn keep_channels(&mut self, ids: impl IntoIterator<Item = String>) {
        self.machine.keep = Some(Arc::new(ids.into_iter().collect()));
    }

    pub fn finish(&mut self) -> Result<Batch, String> {
        let mut batch = Batch::default();
        let rest = match std::mem::replace(&mut self.input, Input::Plain) {
            Input::Head(head) => head,
            Input::Plain => Vec::new(),
            Input::Gzip(d) => d.finish().map_err(|e| format!("xmltv_gunzip:{e}"))?,
        };
        self.feed(&rest, true, &mut batch)?;
        Ok(batch)
    }

    fn gunzip(&mut self, chunk: &[u8]) -> Result<Vec<u8>, String> {
        let Input::Gzip(d) = &mut self.input else {
            unreachable!()
        };
        d.write_all(chunk)
            .map_err(|e| format!("xmltv_gunzip:{e}"))?;
        Ok(std::mem::take(d.get_mut()))
    }

    fn feed(&mut self, bytes: &[u8], last: bool, batch: &mut Batch) -> Result<(), String> {
        if let Some(buf) = &mut self.sniff {
            buf.extend_from_slice(bytes);
            sniff_channels(buf, &mut batch.channels);
        }
        self.unparsed.extend_from_slice(bytes);
        if !last && self.unparsed.len() < PARALLEL_BATCH {
            return Ok(());
        }
        let cut = if last {
            self.unparsed.len()
        } else {
            // A </channel> that counts sits after the last </programme>, so
            // only that tail is searched: the programme section has none, and
            // a whole-buffer search for one ran on every push.
            let programme = memchr::memmem::rfind(&self.unparsed, b"</programme>").map(|i| i + 12);
            let tail = programme.unwrap_or(0);
            let channel =
                memchr::memmem::rfind(&self.unparsed[tail..], b"</channel>").map(|i| tail + i + 10);
            match channel.or(programme) {
                Some(cut) => cut,
                None if self.unparsed.len() > UNPARSED_MAX => {
                    return Err("xmltv_element_too_large".into());
                }
                None => return Ok(()),
            }
        };
        // Parse in place, then drop what was parsed (no copy of the fragment).
        let mut unparsed = std::mem::take(&mut self.unparsed);
        let mut fragment = &unparsed[..cut];
        if std::mem::take(&mut self.first_fragment) {
            fragment = fragment.strip_prefix(b"\xef\xbb\xbf").unwrap_or(fragment);
        }
        let parsed = self.machine.parse_split(fragment, &mut batch.programmes);
        unparsed.drain(..cut);
        self.unparsed = unparsed;
        parsed
    }
}

impl Machine {
    /// Parse `text`, split at programme boundaries across threads when it is
    /// large. Each piece starts from a clean state, which is what the serial
    /// parse has after a </programme>; if a piece does not end clean (a
    /// malformed feed left a title open across a programme), the whole text
    /// is parsed serially instead, so the output never differs.
    /// Pieces split right after an ASCII '>', so each is decoded on its own
    /// thread with the same result as decoding the whole.
    fn parse_split(&mut self, text: &[u8], out: &mut Vec<Programme>) -> Result<(), String> {
        let threads = std::thread::available_parallelism()
            .map_or(1, |n| n.get())
            .min(MAX_THREADS);
        let pieces = split_at_programme_ends(text, threads);
        if pieces.len() < 2 {
            return self.parse_bytes(text, out);
        }
        let first = self.clone();
        let blank = Machine {
            keep: self.keep.clone(),
            ..Machine::default()
        };
        let results: Vec<(Machine, Result<Vec<Programme>, String>)> = std::thread::scope(|s| {
            let handles: Vec<_> = pieces
                .iter()
                .enumerate()
                .map(|(i, piece)| {
                    let mut m = if i == 0 { first.clone() } else { blank.clone() };
                    s.spawn(move || {
                        let mut progs = Vec::new();
                        let r = m.parse_bytes(piece, &mut progs).map(|()| progs);
                        (m, r)
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|h| h.join().expect("xmltv worker panicked"))
                .collect()
        });
        let clean = results[..results.len() - 1]
            .iter()
            .all(|(m, r)| r.is_err() || m.is_clean());
        if !clean {
            return self.parse_bytes(text, out);
        }
        let mut end = Machine::default();
        for (m, r) in results {
            out.extend(r?);
            end = m;
        }
        *self = end;
        Ok(())
    }

    // The strict check is the fast path; lossy only for a feed with bad bytes.
    fn parse_bytes(&mut self, bytes: &[u8], out: &mut Vec<Programme>) -> Result<(), String> {
        match std::str::from_utf8(bytes) {
            Ok(text) => self.parse(text, out),
            Err(_) => self.parse(&String::from_utf8_lossy(bytes), out),
        }
    }

    fn is_clean(&self) -> bool {
        self.cur.is_none() && !self.in_title && !self.in_desc
    }

    fn parse(&mut self, fragment: &str, out: &mut Vec<Programme>) -> Result<(), String> {
        let mut reader = Reader::from_str(fragment);
        let config = reader.config_mut();
        config.check_end_names = false; // a fragment closes tags opened in an earlier one
        config.allow_unmatched_ends = true;
        // sax's text node: character data and references up to the next markup.
        let mut node = String::new();
        loop {
            let event = reader
                .read_event()
                .map_err(|e| format!("xmltv_parse:{e}"))?;
            match event {
                Event::Text(t) => node.push_str(&t),
                Event::GeneralRef(r) => push_ref(&mut node, &r)?,
                other => {
                    self.close_text(&mut node);
                    match other {
                        Event::Start(e) => self.open(&e)?,
                        Event::Empty(e) => {
                            self.open(&e)?;
                            self.close(e.name().as_ref(), out);
                        }
                        Event::End(e) => self.close(e.name().as_ref(), out),
                        Event::CData(c) if self.in_title || self.in_desc => self.text.push_str(&c),
                        Event::Eof => return Ok(()),
                        _ => {}
                    }
                }
            }
        }
    }

    // sax trims and collapses whitespace in each text node before emitting it.
    fn close_text(&mut self, node: &mut String) {
        if node.is_empty() {
            return;
        }
        let trimmed = node.trim_matches(js_ws);
        if !trimmed.is_empty() && (self.in_title || self.in_desc) {
            let mut prev_ws = false;
            for c in trimmed.chars() {
                if js_ws(c) {
                    if !prev_ws {
                        self.text.push(' ');
                    }
                    prev_ws = true;
                } else {
                    self.text.push(c);
                    prev_ws = false;
                }
            }
        }
        node.clear();
    }

    fn open(&mut self, e: &BytesStart) -> Result<(), String> {
        let name = e.name();
        let programme = name.as_ref() == "programme";
        // Every attribute is unescaped, as sax did, so a bad entity anywhere
        // fails. Only the three a programme uses are kept, and a repeated one
        // overwrites the earlier, as in sax's attribute object.
        let (mut start, mut stop, mut channel) = (None, None, None);
        for a in e.attributes().with_checks(false) {
            let a = a.map_err(|e| format!("xmltv_parse:{e}"))?;
            let value = unescape(&a.value).map_err(|e| format!("xmltv_parse:{e}"))?;
            if programme {
                let slot = match a.key.as_ref() {
                    "start" => &mut start,
                    "stop" => &mut stop,
                    "channel" => &mut channel,
                    _ => continue,
                };
                *slot = Some(value.into_owned());
            }
        }
        match name.as_ref() {
            "programme" => {
                let channel_id = channel
                    .as_deref()
                    .map(normalize_epg_channel_id)
                    .unwrap_or_default();
                if self.keep.as_ref().is_some_and(|k| !k.contains(&channel_id)) {
                    self.cur = None;
                    return Ok(());
                }
                self.cur = match (
                    start.as_deref().and_then(xmltv_time_to_iso),
                    stop.as_deref().and_then(xmltv_time_to_iso),
                ) {
                    (Some(start_utc), Some(stop_utc)) => Some(Programme {
                        channel_id,
                        start_utc,
                        stop_utc,
                        title: None,
                        description: None,
                    }),
                    _ => None,
                };
            }
            "title" if self.cur.is_some() => {
                self.in_title = true;
                self.text.clear();
            }
            "desc" if self.cur.is_some() => {
                self.in_desc = true;
                self.text.clear();
            }
            _ => {}
        }
        Ok(())
    }

    fn close(&mut self, name: &str, out: &mut Vec<Programme>) {
        let Some(cur) = &mut self.cur else { return };
        let text = |t: String| (!t.is_empty()).then_some(t);
        match name {
            "title" if self.in_title => {
                cur.title = text(std::mem::take(&mut self.text));
                self.in_title = false;
            }
            "desc" if self.in_desc => {
                cur.description = text(std::mem::take(&mut self.text));
                self.in_desc = false;
            }
            "programme" => {
                if let Some(p) = self.cur.take().filter(|p| !p.channel_id.is_empty()) {
                    out.push(p);
                }
            }
            _ => {}
        }
    }
}

fn push_ref(node: &mut String, r: &BytesRef) -> Result<(), String> {
    if let Some(c) = r
        .resolve_char_ref()
        .map_err(|e| format!("xmltv_parse:{e}"))?
    {
        node.push(c);
    } else if let Some(s) = resolve_predefined_entity(r) {
        node.push_str(s);
    } else {
        return Err(format!("xmltv_parse:unknown entity &{};", &**r));
    }
    Ok(())
}

/// `text` cut into up to `n` pieces of similar size, each ending just after a
/// `</programme>` (the last takes the rest).
fn split_at_programme_ends(text: &[u8], n: usize) -> Vec<&[u8]> {
    let mut pieces = Vec::with_capacity(n);
    let mut start = 0;
    for k in 1..n {
        let target = (text.len() * k / n).max(start);
        match memchr::memmem::find(&text[target..], b"</programme>") {
            Some(i) => {
                let end = target + i + 12;
                pieces.push(&text[start..end]);
                start = end;
            }
            None => break,
        }
    }
    pieces.push(&text[start..]);
    pieces
}

/// Emit every complete <channel> block in `buf`, then drop all but a trailing
/// partial one (or a short carry for a tag split across chunks).
fn sniff_channels(buf: &mut Vec<u8>, out: &mut Vec<ChannelDef>) {
    let mut last_end = 0;
    for m in CHANNEL_RE.captures_iter(buf) {
        let names = DISPLAY_NAME_RE
            .captures_iter(&m[2])
            .map(|d| {
                String::from_utf8_lossy(&d[1])
                    .trim_matches(js_ws)
                    .to_owned()
            })
            .filter(|t| !t.is_empty())
            .collect();
        out.push(ChannelDef {
            id: String::from_utf8_lossy(&m[1]).into_owned(),
            names,
        });
        last_end = m.get(0).unwrap().end();
    }
    buf.drain(..last_end);
    // The last "<channel", found with the forward (SIMD) searcher: the reverse
    // one scanned every pushed chunk of the programme section, which has none.
    match memchr::memmem::find_iter(buf, b"<channel").last() {
        None => {
            let keep = buf.len().saturating_sub(16);
            buf.drain(..keep);
        }
        Some(i) => {
            buf.drain(..i);
        }
    }
    if buf.len() > SNIFF_BUF_MAX {
        let keep = buf.len() - SNIFF_BUF_MAX;
        buf.drain(..keep);
    }
}

/// JavaScript's `\s` and `String.prototype.trim` whitespace.
fn js_ws(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// `normalizeEpgChannelId`: trimmed and lowercased, '' when empty.
pub fn normalize_epg_channel_id(id: &str) -> String {
    id.trim_matches(js_ws).to_lowercase()
}

/// `xmltvTimeToIso`: "YYYYMMDDhhmmss +HHMM" to an ISO-8601 UTC string, None
/// when malformed. Fields overflow the way Date.UTC lets them (month 13 is
/// January next year) and years 0-99 mean 1900-1999, as there.
pub fn xmltv_time_to_iso(s: &str) -> Option<String> {
    let s = s.trim_matches(js_ws);
    let b = s.as_bytes();
    if b.len() < 19 || !b[..14].iter().all(u8::is_ascii_digit) {
        return None;
    }
    let off = &s[s.len() - 5..];
    let ob = off.as_bytes();
    if !matches!(ob[0], b'+' | b'-')
        || !ob[1..].iter().all(u8::is_ascii_digit)
        || !s[14..s.len() - 5].chars().all(js_ws)
    {
        return None;
    }
    let num = |r: std::ops::Range<usize>| s[r].parse::<i64>().unwrap();
    let mut year = num(0..4);
    if year <= 99 {
        year += 1900;
    }
    let month0 = num(4..6) - 1;
    let days =
        days_from_civil(year + month0.div_euclid(12), month0.rem_euclid(12) + 1, 1) + num(6..8) - 1;
    let sign = if ob[0] == b'+' { 1 } else { -1 };
    let offset_min = num(s.len() - 4..s.len() - 2) * 60 + num(s.len() - 2..s.len());
    let secs =
        days * 86_400 + num(8..10) * 3600 + num(10..12) * 60 + num(12..14) - sign * offset_min * 60;
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    let t = secs.rem_euclid(86_400);
    // Digits written directly: format! was a tenth of the parse.
    let mut out = String::with_capacity(27);
    if (0..=9999).contains(&y) {
        push_digits(&mut out, y, 4);
    } else {
        out.push(if y < 0 { '-' } else { '+' });
        push_digits(&mut out, y.abs(), 6);
    }
    for (sep, value) in [
        ('-', m),
        ('-', d),
        ('T', t / 3600),
        (':', t % 3600 / 60),
        (':', t % 60),
    ] {
        out.push(sep);
        push_digits(&mut out, value, 2);
    }
    out.push_str(".000Z");
    Some(out)
}

/// `value` zero-padded to `width` digits (wider values keep every digit).
fn push_digits(out: &mut String, value: i64, width: u32) {
    let digits = value.checked_ilog10().unwrap_or(0) + 1;
    for _ in digits..width {
        out.push('0');
    }
    for i in (0..digits).rev() {
        out.push(char::from(b'0' + (value / 10_i64.pow(i) % 10) as u8));
    }
}

// Howard Hinnant's civil-date algorithms (proleptic Gregorian, day 0 = 1970-01-01).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::Compression;
    use flate2::write::GzEncoder;

    const FEED: &str = "\u{feff}<?xml version=\"1.0\"?><tv>\
        <channel id=\"Caf\u{e9}.us\"><display-name> AT&amp;T Caf\u{e9} </display-name><display-name>Cafe</display-name></channel>\
        <programme channel=\" CNN.us \" start=\"20261016230000 -0400\" stop=\"20261017000000 -0400\">\
          <title lang=\"en\">  First \n\t title </title><title>Second &amp; &#65;&#x42; <![CDATA[ raw  cdata ]]></title>\
          <desc></desc></programme>\
        <programme channel=\"\" start=\"20261016000000 +0000\" stop=\"20261016010000 +0000\"><title>no channel</title></programme>\
        <programme channel=\"bad.us\" start=\"garbage\" stop=\"20261016010000 +0000\"><title>bad time</title></programme>\
        <programme channel=\"empty.us\" start=\"20261016000000 +0000\" stop=\"20261016010000 +0000\"/>\
        <channel id=\"late.us\"><display-name>Late</display-name></channel></tv>";

    fn run(bytes: &[u8], chunk: usize) -> (Vec<Programme>, Vec<ChannelDef>) {
        let mut p = Parser::new(true);
        let (mut progs, mut chans) = (Vec::new(), Vec::new());
        let mut batches: Vec<Batch> = bytes.chunks(chunk).map(|c| p.push(c).unwrap()).collect();
        batches.push(p.finish().unwrap());
        for c in batches {
            progs.extend(c.programmes);
            chans.extend(c.channels);
        }
        (progs, chans)
    }

    #[test]
    fn parses_like_the_sax_pipeline() {
        let (progs, chans) = run(FEED.as_bytes(), 1 << 20);
        assert_eq!(
            progs,
            vec![
                Programme {
                    channel_id: "cnn.us".into(),
                    start_utc: "2026-10-17T03:00:00.000Z".into(),
                    stop_utc: "2026-10-17T04:00:00.000Z".into(),
                    title: Some("Second & AB raw  cdata ".into()),
                    description: None,
                },
                Programme {
                    channel_id: "empty.us".into(),
                    start_utc: "2026-10-16T00:00:00.000Z".into(),
                    stop_utc: "2026-10-16T01:00:00.000Z".into(),
                    title: None,
                    description: None,
                },
            ]
        );
        assert_eq!(
            chans,
            vec![
                ChannelDef {
                    id: "Caf\u{e9}.us".into(),
                    names: vec!["AT&amp;T Caf\u{e9}".into(), "Cafe".into()]
                },
                ChannelDef {
                    id: "late.us".into(),
                    names: vec!["Late".into()]
                },
            ]
        );
    }

    #[test]
    fn chunking_and_gzip_do_not_change_output() {
        let whole = run(FEED.as_bytes(), 1 << 20);
        for chunk in [1, 2, 3, 7, 64] {
            assert_eq!(run(FEED.as_bytes(), chunk), whole, "plain, chunk {chunk}");
        }
        // Two gzip members, as a concatenated .gz stream delivers them.
        let gz = |s: &[u8]| {
            let mut e = GzEncoder::new(Vec::new(), Compression::default());
            e.write_all(s).unwrap();
            e.finish().unwrap()
        };
        let (a, b) = FEED.as_bytes().split_at(FEED.len() / 2);
        let gzipped = [gz(a), gz(b)].concat();
        for chunk in [1, 5, 4096] {
            assert_eq!(run(&gzipped, chunk), whole, "gzip, chunk {chunk}");
        }
    }

    #[test]
    fn malformed_text_fails_like_sax() {
        for bad in [
            "<tv><programme channel=\"a\" start=\"20261016000000 +0000\" stop=\"20261016010000 +0000\"><title>A & B</title></programme></tv>",
            "<tv><programme channel=\"a\" start=\"20261016000000 +0000\" stop=\"20261016010000 +0000\"><title>&nbsp;</title></programme></tv>",
            "<tv><icon src=\"x?a=1&b=2\"/></tv>",
        ] {
            let mut p = Parser::new(false);
            assert!(
                p.push(bad.as_bytes()).and_then(|_| p.finish()).is_err(),
                "{bad}"
            );
        }
        let mut p = Parser::new(false);
        let gz = {
            let mut e = GzEncoder::new(Vec::new(), Compression::default());
            e.write_all(FEED.as_bytes()).unwrap();
            e.finish().unwrap()
        };
        assert!(
            p.push(&gz[..gz.len() / 2])
                .and_then(|_| p.finish())
                .is_err(),
            "truncated gzip"
        );
    }

    fn big_feed(n: usize, break_at: Option<usize>) -> String {
        let mut s = String::from("<tv>");
        for i in 0..n {
            let title = if Some(i) == break_at {
                // A title left open across the programme end: state carries
                // over, and the next programme's bare </title> closes it.
                "<title>open".to_string()
            } else if break_at.is_some_and(|b| i == b + 1) {
                "carry</title>".to_string()
            } else {
                format!("<title>Show {i} &amp; more</title>")
            };
            s.push_str(&format!(
                "<programme channel=\"ch{}.us\" start=\"20261016{:02}0000 +0000\" stop=\"20261016{:02}3000 +0000\">{title}<desc>  Episode\n {i}  </desc></programme>\n",
                i % 97,
                i % 24,
                i % 24
            ));
        }
        s.push_str("</tv>");
        s
    }

    fn serial(text: &str) -> Result<Vec<Programme>, String> {
        let mut out = Vec::new();
        Machine::default().parse(text, &mut out).map(|()| out)
    }

    fn split(text: &str) -> Result<Vec<Programme>, String> {
        let mut out = Vec::new();
        Machine::default()
            .parse_split(text.as_bytes(), &mut out)
            .map(|()| out)
    }

    #[test]
    fn parallel_parse_matches_serial() {
        let feed = big_feed(40_000, None);
        assert!(split_at_programme_ends(feed.as_bytes(), 4).len() == 4);
        assert_eq!(split(&feed).unwrap(), serial(&feed).unwrap());
        // A piece that ends mid-title falls back to the serial parse: put the
        // open title at each programme near the first split, check the naive
        // per-piece parse really differs at least once, and that the split
        // parse never does.
        let threads = std::thread::available_parallelism()
            .map_or(1, |n| n.get())
            .min(MAX_THREADS);
        let first_piece = memchr::memmem::find_iter(
            split_at_programme_ends(feed.as_bytes(), threads)[0],
            b"</programme>",
        )
        .count();
        let mut naive_differed = false;
        for k in first_piece.saturating_sub(3)..first_piece + 3 {
            let broken = big_feed(40_000, Some(k));
            let naive: Vec<Programme> = split_at_programme_ends(broken.as_bytes(), threads)
                .iter()
                .flat_map(|p| serial(std::str::from_utf8(p).unwrap()).unwrap())
                .collect();
            naive_differed |= naive != serial(&broken).unwrap();
            assert_eq!(
                split(&broken).unwrap(),
                serial(&broken).unwrap(),
                "open title at {k}"
            );
        }
        assert!(
            threads < 2 || naive_differed,
            "no case exercised the serial fallback"
        );
        // An error in a later piece still fails the whole parse.
        let bad = big_feed(40_000, None).replacen("Show 30000 &amp;", "Show 30000 &", 1);
        assert!(split(&bad).is_err() && serial(&bad).is_err());
    }

    #[test]
    fn large_feed_through_push_matches_one_serial_parse() {
        let feed = big_feed(150_000, None);
        assert!(feed.len() > PARALLEL_BATCH);
        let (progs, _) = run(feed.as_bytes(), 64 * 1024);
        assert_eq!(progs, serial(&feed).unwrap());
    }

    #[test]
    fn kept_channels_match_a_filtered_parse_and_stay_strict() {
        let keep = ["ch3.us", "ch40.us"];
        let filtered = |feed: &str| {
            let mut p = Parser::new(false);
            p.keep_channels(keep.map(String::from));
            let mut progs = Vec::new();
            for c in feed.as_bytes().chunks(64 * 1024) {
                progs.extend(p.push(c)?.programmes);
            }
            progs.extend(p.finish()?.programmes);
            Ok::<_, String>(progs)
        };
        let feed = big_feed(150_000, None);
        let want: Vec<Programme> = serial(&feed)
            .unwrap()
            .into_iter()
            .filter(|p| keep.contains(&p.channel_id.as_str()))
            .collect();
        assert!(!want.is_empty());
        assert_eq!(filtered(&feed).unwrap(), want);
        // Programme 30001 is on ch28, which is skipped: bad text in it still fails.
        for bad in ["Show 30001 &", "Show 30001 &nbsp;"] {
            let broken = feed.replacen("Show 30001 &amp;", bad, 1);
            assert!(filtered(&broken).is_err(), "{bad}");
        }
    }

    #[test]
    fn times_follow_date_utc() {
        let t = |s| xmltv_time_to_iso(s);
        assert_eq!(
            t("20261016123000 +0000").as_deref(),
            Some("2026-10-16T12:30:00.000Z")
        );
        assert_eq!(
            t(" 20261016123000+0530 ").as_deref(),
            Some("2026-10-16T07:00:00.000Z")
        );
        assert_eq!(
            t("20261231230000 -0200").as_deref(),
            Some("2027-01-01T01:00:00.000Z")
        );
        assert_eq!(
            t("20261301000000 +0000").as_deref(),
            Some("2027-01-01T00:00:00.000Z")
        );
        assert_eq!(
            t("20260300000000 +0000").as_deref(),
            Some("2026-02-28T00:00:00.000Z")
        );
        assert_eq!(
            t("00991016000000 +0000").as_deref(),
            Some("1999-10-16T00:00:00.000Z")
        );
        assert_eq!(
            t("99991231230000 -0200").as_deref(),
            Some("+010000-01-01T01:00:00.000Z")
        );
        assert_eq!(
            t("20260101000000 +0001").as_deref(),
            Some("2025-12-31T23:59:00.000Z")
        );
        assert_eq!(t("20261016123000"), None);
        assert_eq!(t("2026101612300 +0000"), None);
        assert_eq!(t("20261016123000 0000"), None);
    }
}

/// Release-mode timing on a real feed, kept out of the normal run:
/// `XMLTV_BENCH=<feed> cargo test --release -p emerald-contracts-napi --lib xmltv_bench -- --ignored --nocapture`
#[cfg(test)]
mod bench {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    #[ignore]
    fn xmltv_bench() {
        let path = std::env::var("XMLTV_BENCH").expect("XMLTV_BENCH=<feed path>");
        let bytes = std::fs::read(&path).unwrap();
        for _ in 0..3 {
            let (mut parse, mut json) = (Duration::ZERO, Duration::ZERO);
            let (mut progs, mut chans, mut json_bytes) = (0, 0, 0);
            let mut p = Parser::new(std::env::var("XMLTV_BENCH_NO_SNIFF").is_err());
            let mut account = |b: Batch, parse_t: Duration| {
                parse += parse_t;
                progs += b.programmes.len();
                chans += b.channels.len();
                let t = Instant::now();
                json_bytes += serde_json::to_string(&b).unwrap().len();
                json += t.elapsed();
            };
            for c in bytes.chunks(64 * 1024) {
                let t = Instant::now();
                let b = p.push(c).unwrap();
                account(b, t.elapsed());
            }
            let t = Instant::now();
            let b = p.finish().unwrap();
            account(b, t.elapsed());
            eprintln!(
                "{path}: parse {parse:.2?} json {json:.2?} | {progs} programmes {chans} channels {} MB json",
                json_bytes / 1_000_000
            );
        }
    }
}
