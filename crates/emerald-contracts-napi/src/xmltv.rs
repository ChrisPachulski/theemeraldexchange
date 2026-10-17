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

use std::io::Write;
use std::sync::LazyLock;

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
    Gzip(MultiGzDecoder<Vec<u8>>),
}

pub struct Parser {
    input: Input,
    sniff: Option<Vec<u8>>,
    unparsed: Vec<u8>,
    first_fragment: bool,
    cur: Option<Programme>,
    in_title: bool,
    in_desc: bool,
    text: String,
}

impl Parser {
    pub fn new(sniff_channels: bool) -> Self {
        Parser {
            input: Input::Head(Vec::new()),
            sniff: sniff_channels.then(Vec::new),
            unparsed: Vec::new(),
            first_fragment: true,
            cur: None,
            in_title: false,
            in_desc: false,
            text: String::new(),
        }
    }

    pub fn push(&mut self, chunk: &[u8]) -> Result<Batch, String> {
        let mut batch = Batch::default();
        let bytes = match &mut self.input {
            Input::Head(head) => {
                head.extend_from_slice(chunk);
                if head.len() < 2 {
                    return Ok(batch);
                }
                let head = std::mem::take(head);
                if head[..2] == [0x1f, 0x8b] {
                    self.input = Input::Gzip(MultiGzDecoder::new(Vec::new()));
                    self.gunzip(&head)?
                } else {
                    self.input = Input::Plain;
                    head
                }
            }
            Input::Plain => chunk.to_vec(),
            Input::Gzip(_) => self.gunzip(chunk)?,
        };
        self.feed(&bytes, false, &mut batch)?;
        Ok(batch)
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
        let cut = if last {
            self.unparsed.len()
        } else {
            let end =
                |tag: &[u8]| memchr::memmem::rfind(&self.unparsed, tag).map(|i| i + tag.len());
            match end(b"</programme>").max(end(b"</channel>")) {
                Some(cut) => cut,
                None if self.unparsed.len() > UNPARSED_MAX => {
                    return Err("xmltv_element_too_large".into());
                }
                None => return Ok(()),
            }
        };
        let fragment = self.unparsed.drain(..cut).collect::<Vec<u8>>();
        let fragment = String::from_utf8_lossy(&fragment);
        let bom = std::mem::take(&mut self.first_fragment) && fragment.starts_with('\u{feff}');
        self.parse(&fragment[if bom { 3 } else { 0 }..], &mut batch.programmes)
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
        // Every attribute is unescaped, as sax did, so a bad entity anywhere fails.
        let mut attrs: Vec<(String, String)> = Vec::new();
        for a in e.attributes().with_checks(false) {
            let a = a.map_err(|e| format!("xmltv_parse:{e}"))?;
            let value = unescape(&a.value).map_err(|e| format!("xmltv_parse:{e}"))?;
            if programme {
                attrs.push((a.key.as_ref().to_owned(), value.into_owned()));
            }
        }
        // A repeated attribute overwrote the earlier one in sax's attribute object.
        let attr = |key: &str| {
            attrs
                .iter()
                .rev()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.as_str())
        };
        match name.as_ref() {
            "programme" => {
                self.cur = match (
                    attr("start").and_then(xmltv_time_to_iso),
                    attr("stop").and_then(xmltv_time_to_iso),
                ) {
                    (Some(start_utc), Some(stop_utc)) => Some(Programme {
                        channel_id: attr("channel")
                            .map(normalize_epg_channel_id)
                            .unwrap_or_default(),
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
    match memchr::memmem::rfind(buf, b"<channel") {
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
    let year = if (0..=9999).contains(&y) {
        format!("{y:04}")
    } else {
        format!("{}{:06}", if y < 0 { '-' } else { '+' }, y.abs())
    };
    Some(format!(
        "{year}-{m:02}-{d:02}T{:02}:{:02}:{:02}.000Z",
        t / 3600,
        t % 3600 / 60,
        t % 60
    ))
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
        assert_eq!(t("20261016123000"), None);
        assert_eq!(t("2026101612300 +0000"), None);
        assert_eq!(t("20261016123000 0000"), None);
    }
}
