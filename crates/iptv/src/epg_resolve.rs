//! EPG channel resolution (iptvEpgResolve.ts): match a catalog channel to the
//! XMLTV feed channel that carries its schedule.
//!
//! The provider's tvg-id matches the feed for ~806 of 50k channels, but the
//! feed ships ~46k `<display-name>` aliases, so channels are matched by
//! callsign, tvg-id, a same-named stream's tvg-id, then name. A name shared by
//! two feed ids is dropped as ambiguous. The 2026-10-15 guide audit found 69 of
//! 290 name-resolved rows on another channel's schedule (CBS locals on WCBS,
//! FOX locals on the fox.us placeholder, "USA NETWORK WEST" on a westerns
//! channel), so every match passes the vetoes in `rejects`.
//!
//! The JS regexes are kept where Rust's `regex` matches them exactly
//! (leftmost-first, `(?-u)` for JS's ASCII `\b`, `\W` and `i`). The three
//! lookarounds have no `regex` equivalent and are small string checks instead:
//! `name_network`, `strip_country_code` and `ends_with_coast`.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;
use regex::bytes::Regex as BytesRegex;

use crate::xmltv::{ChannelDef, normalize_epg_channel_id};

/// JS `\s`: the whitespace class every `\s` below stands for.
const JS_WS: &str = r"[\t\n\x0B\x0C\r \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]";

fn re(pattern: &str) -> Regex {
    Regex::new(&pattern.replace(r"\s", JS_WS)).unwrap()
}
fn bre(pattern: &str) -> BytesRegex {
    BytesRegex::new(pattern).unwrap()
}

/// Canonical tvg-id: trimmed, lowercased, None when empty.
pub fn epg_id(id: Option<&str>) -> Option<String> {
    id.map(normalize_epg_channel_id).filter(|v| !v.is_empty())
}

// Broadcast networks a US station is branded with. cnbc leads so it is never
// read as nbc; "my" covers MyTV, MyNet and MyNetworkTV.
const NETWORKS: [&str; 11] = [
    "cnbc",
    "abc",
    "cbs",
    "nbc",
    "fox",
    "cw",
    "pbs",
    "telemundo",
    "univision",
    "unimas",
    "my",
];
const NETS: &str = "cnbc|abc|cbs|nbc|fox|cw|pbs|telemundo|univision|unimas|my";

static COUNTRY_PREFIX: LazyLock<Regex> = LazyLock::new(|| re(r"^\s*[A-Za-z]{2,4}\s*[:|–—-]+\s*"));
static QUALITY_TOKENS: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?i-u)\b(?:FHD|UHD|HD|SD|4K|8K|HEVC|H ?265|H ?264|50 ?FPS|60 ?FPS|VIP|RAW|MULTI|BACKUP|ALT|SLOW|FAST)\b",
    )
});
static WEST_PAREN: LazyLock<Regex> = LazyLock::new(|| re(r"\(\s*(?i-u:west|pacific)\s*\)"));
static PARENS: LazyLock<Regex> = LazyLock::new(|| re(r"\([^)]*\)"));
static BRACKETS: LazyLock<Regex> = LazyLock::new(|| re(r"\[[^\]]*\]"));
static NON_ALNUM: LazyLock<Regex> = LazyLock::new(|| re(r"[^A-Za-z0-9]+"));
static NETWORK_WORD: LazyLock<Regex> =
    LazyLock::new(|| re(&format!(r"^(?:{NETS})(?:net(?:work)?)?(?:tv)?$")));
static ID_NETWORK: LazyLock<Regex> = LazyLock::new(|| re(&format!(r"^({NETS})")));
// A bare network id (fox.us, abc5.us, mytv.us, telemundo.us) is one market's
// schedule or a placeholder, never a named station's.
static BARE_NETWORK: LazyLock<Regex> = LazyLock::new(|| re(&format!(r"^(?:{NETS})(?:tv)?[0-9]*$")));
// Where an id carries a callsign: after its network and channel number, or as
// the whole id ("wusa9.us", "koco-dt.us_locals1").
static ID_CALLSIGN: LazyLock<Regex> =
    LazyLock::new(|| re(&format!(r"^(?:{NETS})?[0-9]*([wk][a-z]{{2}})([a-z]?)")));
static ONLY_CALLSIGN: LazyLock<Regex> =
    LazyLock::new(|| re(r"^[wk][a-z]{2,3}(?:dt|ld|cd)?[0-9]*$"));
static ID_LEAD: LazyLock<Regex> = LazyLock::new(|| re(&format!(r"^(?:{NETS})?[0-9]*")));
static ID_PREFIX_TAG: LazyLock<Regex> = LazyLock::new(|| re(r"^\[[^\]]*\]"));
static ID_COUNTRY_SUFFIX: LazyLock<Regex> =
    LazyLock::new(|| re(r"\.[a-z]{2,3}(?:[0-9]|_locals[0-9]*|\.plus[0-9])?$"));
static ID_NON_ALNUM: LazyLock<Regex> = LazyLock::new(|| re(r"[^a-z0-9]+"));
static COUNTRY: LazyLock<Regex> = LazyLock::new(|| re(r"\.([a-z]{2,3})(?:[0-9]|_locals[0-9]*)?$"));
static SHORT_SUFFIX: LazyLock<Regex> = LazyLock::new(|| re(r"\.[a-z]{2,3}$"));
static CALLSIGN_PAREN: LazyLock<Regex> =
    LazyLock::new(|| re(r"\(([WK][A-Z]{2,3})(?:-[A-Z0-9]+)?\)"));
static NAME_CALLSIGN: LazyLock<Regex> = LazyLock::new(|| re(r"(?-u:\b)[WK][A-Z]{2,3}(?-u:\b)"));
static LOWER_SPLIT: LazyLock<Regex> = LazyLock::new(|| re(r"[^a-z]+"));
static SUBCHANNEL: LazyLock<Regex> = LazyLock::new(|| re(r"-[a-z]{2}[0-9]"));
static AFTER_CALLSIGN: LazyLock<Regex> = LazyLock::new(|| re(r"^(?:[0-9]|dt|ld|cd|tv)"));
static DIGITS: LazyLock<Regex> = LazyLock::new(|| re(r"[0-9]+"));
static IS_US: LazyLock<BytesRegex> = LazyLock::new(|| bre(r"(?i-u)^\W*usa?\b"));
static IS_WEST: LazyLock<BytesRegex> = LazyLock::new(|| bre(r"(?i-u)\b(?:west|pacific)\b"));
static CINEBOX: LazyLock<BytesRegex> = LazyLock::new(|| bre(r"(?i-u)^\W*cinebox\b"));

const BARE_COUNTRIES: [&str; 23] = [
    "US", "USA", "UK", "CA", "AU", "NZ", "IE", "DE", "FR", "ES", "IT", "PT", "NL", "SE", "NO",
    "DK", "FI", "PL", "BR", "MX", "AR", "IN", "ZA",
];

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

/// `^\s*(?:US|USA|…)\b(?!\s+network)\s+` (case-insensitive): a bare country
/// code and the space after it, unless "network" follows ("USA Network" is
/// the brand).
fn strip_country_code(s: &str) -> &str {
    let rest = s.trim_start_matches(js_ws);
    for code in BARE_COUNTRIES {
        let Some(head) = rest.get(..code.len()) else {
            continue;
        };
        if !head.eq_ignore_ascii_case(code) {
            continue;
        }
        let after = &rest[code.len()..];
        if !after.starts_with(js_ws) {
            continue;
        }
        let word = after.trim_start_matches(js_ws);
        if word
            .get(..7)
            .is_some_and(|w| w.eq_ignore_ascii_case("network"))
        {
            continue;
        }
        return word;
    }
    s
}

/// Canonical comparison key for a channel name: no leading country prefix
/// ("US:", "UK |", "DK -", or a bare "UK "), parentheticals, quality tokens or
/// non-alphanumerics, lowercased. "(West)"/"(Pacific)" survive as "west": a
/// West feed is its own schedule. None under 3 chars (too generic to match).
pub fn normalize_channel_name(s: Option<&str>) -> Option<String> {
    let s = s.filter(|s| !s.is_empty())?;
    let v = COUNTRY_PREFIX.replace(s, "");
    let v = QUALITY_TOKENS.replace_all(&v, " ");
    let v = strip_country_code(&v);
    let v = WEST_PAREN.replace_all(v, " west ");
    let v = PARENS.replace_all(&v, " ");
    let v = BRACKETS.replace_all(&v, " ");
    let v = NON_ALNUM.replace_all(&v, "").to_ascii_lowercase();
    (v.len() >= 3).then_some(v)
}

#[derive(Default)]
pub struct EpgNameIndex {
    /// Feed channel ids (lowercased) that have at least one programme.
    pub feed_with_epg: HashSet<String>,
    /// Normalized unambiguous name -> its single feed id.
    name_to_feed_id: HashMap<String, String>,
    /// Normalized name shared by several feed ids of which one is US -> that id.
    us_name_to_feed_id: HashMap<String, String>,
    /// Callsign -> feed ids whose id carries it ("nbcwtvjmiamifl.us" -> wtvj).
    id_callsigns: HashMap<String, Vec<String>>,
    /// Callsign -> feed ids whose display names carry it.
    name_callsigns: HashMap<String, Vec<String>>,
    /// Normalized catalog name -> the tvg-id same-named streams carry.
    pub catalog_tvg: HashMap<String, String>,
    /// Feed id -> last programme stop, to prefer the longer schedule.
    pub last_stop: HashMap<String, String>,
}

/// The catalog fields resolution reads.
#[derive(Clone, Debug)]
pub struct CatalogChannel {
    pub name: String,
    pub epg_channel_id: Option<String>,
}

// Parts of a name that mark a different channel of the same brand.
const SUB_BRANDS: [&str; 5] = ["bet", "jr", "dodgers", "lakers", "sony"];
// Channels whose feed id goes by a newer or fuller name (checked against the
// schedules on 2026-10-15; see iptvEpgResolve.ts for each one's story).
const RENAMES: [(&str, &str); 8] = [
    ("hbohits", "hbo2"),
    ("newsy", "scrippsnews"),
    ("showtimebet", "shoxbet"),
    ("hallmarkdrama", "hallmarkfamily"),
    ("disneyjr", "disneyjunior"),
    ("sonymovies", "sonymoviechannel"),
    ("sportsnetladodgers", "sportsnetla"),
    ("sportsnetdodgers", "sportsnetla"),
];

/// "abc.(kgun).tucson,.az.us" -> "abckguntucsonaz": the id without its country suffix.
fn id_stem(id: &str) -> String {
    let s = ID_PREFIX_TAG.replace(id, "");
    let s = ID_COUNTRY_SUFFIX.replace(&s, "");
    ID_NON_ALNUM.replace_all(&s, "").into_owned()
}

/// Country (or .net) suffix of an id, us2/us_locals1 counting as us.
fn country_of(id: &str) -> Option<&str> {
    COUNTRY
        .captures(id)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str())
}

fn is_us(name: &str) -> bool {
    IS_US.is_match(name.as_bytes())
}

/// `(?<![a-z])(NETWORKS)(?:net(?:work)?)?(?:tv)?(?![a-z])`, case-insensitive:
/// the first network a name is branded with.
fn name_network(name: &str) -> Option<&'static str> {
    let b = name.as_bytes();
    let letter = |i: usize| b.get(i).is_some_and(u8::is_ascii_alphabetic);
    let at = |i: usize, w: &str| {
        b.get(i..i + w.len())
            .is_some_and(|s| s.eq_ignore_ascii_case(w.as_bytes()))
    };
    for i in 0..b.len() {
        if i > 0 && letter(i - 1) {
            continue;
        }
        for net in NETWORKS {
            if !at(i, net) {
                continue;
            }
            let j = i + net.len();
            // Backtracking order: the longest optional parts first.
            for suffix in ["network", "net", ""] {
                if !at(j, suffix) {
                    continue;
                }
                let k = j + suffix.len();
                for tv in ["tv", ""] {
                    if at(k, tv) && !letter(k + tv.len()) {
                        return Some(net);
                    }
                }
            }
        }
    }
    None
}

/// `(?:(?<!mid|north|south)west|pacific)\W*$` on the id without its last
/// `.suffix`: the id names a West feed.
fn ends_with_coast(id: &str) -> bool {
    let s = match id.rfind('.') {
        Some(i) if i + 1 < id.len() => &id[..i],
        _ => id,
    };
    let s = s.trim_end_matches(|c: char| !(c.is_ascii_alphanumeric() || c == '_'));
    s.ends_with("pacific")
        || s.strip_suffix("west").is_some_and(|head| {
            !(head.ends_with("mid") || head.ends_with("north") || head.ends_with("south"))
        })
}

struct Station {
    key: Option<String>,
    us: bool,
    west: bool,
    network: Option<&'static str>,
    callsign: Option<String>,
    /// Name words that are not network, coast or callsign: the station's city.
    words: Vec<String>,
    /// Every letter of the name outside parentheses.
    letters: String,
    tvg_country: Option<String>,
}

fn parse_station(name: &str, tvg: Option<&str>) -> Station {
    let network = name_network(name);
    // Only a network-branded name has a callsign: "(WNBA)" and "NBA (WAS)" do not.
    let callsign = network
        .and_then(|_| CALLSIGN_PAREN.captures(name))
        .map(|c| c[1].to_lowercase());
    let lower = name.to_lowercase();
    let words = LOWER_SPLIT
        .split(&lower)
        .filter(|w| {
            w.len() >= 4
                && Some(*w) != callsign.as_deref()
                && !NETWORK_WORD.is_match(w)
                && !matches!(*w, "west" | "east" | "pacific" | "backup" | "hevc")
        })
        .map(String::from)
        .collect();
    let letters = PARENS
        .replace_all(&lower, "")
        .chars()
        .filter(char::is_ascii_lowercase)
        .collect();
    Station {
        key: normalize_channel_name(Some(name)),
        us: is_us(name),
        west: IS_WEST.is_match(name.as_bytes()),
        network: network.map(|n| if n.starts_with("my") { "my" } else { n }),
        callsign,
        words,
        letters,
        tvg_country: tvg.and_then(country_of).map(String::from),
    }
}

/// Whether `id` cannot be this station's guide. Every pass checks the network
/// (an NBC station never lists ABC or CNBC) and, for a station with a callsign,
/// that the id is that station. A US stream also keeps its sub-brand, never
/// takes a bare network id when its name says more, and takes a foreign id only
/// when it starts like the name and agrees with its tvg-id's country. A name
/// match (`key`) must also keep the name's coast and channel number.
fn rejects(st: &Station, id: &str, key: Option<&str>) -> bool {
    let stem = id_stem(id);
    let id_network = ID_NETWORK
        .captures(&stem)
        .map(|c| c.get(1).unwrap().as_str());
    if let (Some(n), Some(idn)) = (st.network, id_network)
        && idn != n
    {
        return true;
    }
    let country = country_of(id);
    let foreign = st.us && country.is_some_and(|c| c != "us");
    if st.callsign.is_some() {
        if foreign {
            return true; // kntv.jp is not NBC Bay Area
        }
        if carries(st, id) {
            return false;
        }
        // An id led by another callsign is another station, whatever word it
        // shares with this one's city.
        let rest = ID_LEAD.replace(&stem, "");
        if rest.starts_with(['w', 'k']) && !st.letters.contains(head(&rest, 4)) {
            return true;
        }
        return BARE_NETWORK.is_match(&stem) || !st.words.iter().any(|w| stem.contains(w.as_str()));
    }
    let Some(st_key) = st.key.as_deref().filter(|_| st.us) else {
        return false;
    };
    let name = key.unwrap_or(st_key);
    if !st.words.is_empty() && BARE_NETWORK.is_match(&stem) {
        return true;
    }
    let brand = |s: &str| s.replace("junior", "jr");
    let (bn, bs) = (brand(name), brand(&stem));
    if SUB_BRANDS.iter().any(|t| bn.contains(t) != bs.contains(t)) {
        return true;
    }
    if foreign
        && (!stem.starts_with(head(name, 3))
            || st
                .tvg_country
                .as_deref()
                .is_some_and(|c| Some(c) != country))
    {
        return true;
    }
    let Some(key) = key.filter(|_| st.network.is_none()) else {
        return false;
    };
    if st.west != ends_with_coast(id) {
        return true;
    }
    // A number only the id carries is another channel: showtime2west.us is
    // not Showtime West.
    let numbers: Vec<&str> = DIGITS.find_iter(key).map(|m| m.as_str()).collect();
    stem.bytes().any(|c| c.is_ascii_lowercase())
        && DIGITS
            .find_iter(&stem)
            .any(|n| !numbers.contains(&n.as_str()))
}

fn head(s: &str, n: usize) -> &str {
    &s[..s.len().min(n)]
}

/// Whether the id itself names the station's callsign, after its network and
/// channel number. A 3-letter callsign counts only when a suffix, a number or
/// the station's own name follows; a subchannel (wsvn-dt2) is another channel.
fn carries(st: &Station, id: &str) -> bool {
    let callsign = st.callsign.as_deref().unwrap_or_default();
    let stem = id_stem(id);
    if !(ID_NETWORK.is_match(&stem) || ONLY_CALLSIGN.is_match(&stem)) || SUBCHANNEL.is_match(id) {
        return false;
    }
    let rest = ID_LEAD.replace(&stem, "");
    let Some(after) = rest.strip_prefix(callsign) else {
        return false;
    };
    callsign.len() == 4
        || after.is_empty()
        || AFTER_CALLSIGN.is_match(after)
        || (after.len() >= 4 && st.letters.contains(&after[..4]))
}

/// The station's ids among those carrying its callsign, best first: a US id of
/// its network, then the one whose schedule runs latest, then the provider's
/// own tag, then the one naming its city.
fn by_callsign(st: &Station, index: &EpgNameIndex, tvg: Option<&str>) -> Vec<String> {
    let callsign = st.callsign.as_deref().unwrap_or_default();
    let rank = |id: &str| {
        let stem = id_stem(id);
        let last = index.last_stop.get(id).map_or("0", String::as_str);
        (
            country_of(id).unwrap_or("us") == "us",
            st.network.is_some_and(|n| stem.starts_with(n)),
            head(last, 10).to_string(),
            Some(id) == tvg,
            st.words.iter().any(|w| stem.contains(w.as_str())),
            last.to_string(),
            format!("{:03}", id.len()),
        )
    };
    let ranked = |ids: Vec<&String>| {
        let mut out: Vec<String> = ids
            .into_iter()
            .filter(|id| !rejects(st, id, None))
            .cloned()
            .collect();
        // Stable, so equal ranks keep the feed's order.
        out.sort_by_cached_key(|id| std::cmp::Reverse(rank(id)));
        out
    };
    // A display name is weaker evidence than the id: it must also name the city.
    let by_id = ranked(
        index
            .id_callsigns
            .get(callsign)
            .into_iter()
            .flatten()
            .collect(),
    );
    if !by_id.is_empty() {
        return by_id;
    }
    ranked(
        index
            .name_callsigns
            .get(callsign)
            .into_iter()
            .flatten()
            .filter(|id| {
                let stem = id_stem(id);
                st.words.iter().any(|w| stem.contains(w.as_str()))
            })
            .collect(),
    )
}

/// Every id the callsign pass weighs for this channel, for a feed whose
/// schedules are not known until its programmes stream in (external EPG).
pub fn callsign_ids(channel: &CatalogChannel, index: &EpgNameIndex) -> Vec<String> {
    let tvg = epg_id(channel.epg_channel_id.as_deref());
    let st = parse_station(&channel.name, tvg.as_deref());
    if st.callsign.is_some() {
        by_callsign(&st, index, tvg.as_deref())
    } else {
        Vec::new()
    }
}

/// Build the resolver index from the feed's channel definitions and the set of
/// feed ids that have programmes. Only those ids are indexed, and a normalized
/// name shared by two feed ids is dropped as ambiguous.
pub fn build_epg_name_index(defs: &[ChannelDef], feed_with_epg: HashSet<String>) -> EpgNameIndex {
    let mut collisions: HashMap<String, Vec<String>> = HashMap::new();
    let add = |c: &mut HashMap<String, Vec<String>>, name: Option<String>, id: &str| {
        if let Some(name) = name {
            let ids = c.entry(name).or_default();
            if !ids.iter().any(|i| i == id) {
                ids.push(id.to_string());
            }
        }
    };
    let add_callsign = |m: &mut HashMap<String, Vec<String>>, callsign: String, id: &str| {
        let ids = m.entry(callsign).or_default();
        if !ids.iter().any(|i| i == id) {
            ids.push(id.to_string());
        }
    };
    let mut id_callsigns = HashMap::new();
    let mut name_callsigns = HashMap::new();
    for def in defs {
        let Some(id) = epg_id(Some(&def.id)).filter(|id| feed_with_epg.contains(id)) else {
            continue;
        };
        for nm in &def.names {
            add(&mut collisions, normalize_channel_name(Some(nm)), &id);
            for cs in NAME_CALLSIGN.find_iter(nm) {
                add_callsign(&mut name_callsigns, cs.as_str().to_lowercase(), &id);
            }
        }
        // The id itself sans country suffix ("espn.us" -> "espn").
        add(
            &mut collisions,
            normalize_channel_name(Some(&SHORT_SUFFIX.replace(&id, ""))),
            &id,
        );
        // A 3-letter callsign may be the start of a 4-letter one, so index both.
        let stem = id_stem(&id);
        if let Some(m) = ID_CALLSIGN.captures(&stem)
            && (ID_NETWORK.is_match(&stem) || ONLY_CALLSIGN.is_match(&stem))
        {
            add_callsign(&mut id_callsigns, m[1].to_string(), &id);
            if !m[2].is_empty() {
                add_callsign(&mut id_callsigns, format!("{}{}", &m[1], &m[2]), &id);
            }
        }
    }
    // The feed lists one brand per country (disneyjunior.us, .ca, .de...): for
    // a US stream that is not ambiguous.
    let mut name_to_feed_id = HashMap::new();
    let mut us_name_to_feed_id = HashMap::new();
    for (name, ids) in collisions {
        let us: Vec<&String> = ids
            .iter()
            .filter(|id| country_of(id) == Some("us"))
            .collect();
        if ids.len() > 1 && us.len() == 1 {
            us_name_to_feed_id.insert(name.clone(), us[0].clone());
        }
        if ids.len() == 1 {
            name_to_feed_id.insert(name, ids[0].clone());
        }
    }
    EpgNameIndex {
        feed_with_epg,
        name_to_feed_id,
        us_name_to_feed_id,
        id_callsigns,
        name_callsigns,
        ..Default::default()
    }
}

/// The tvg-id US streams of one normalized name agree on: "US HBO Hits (A)"
/// and "US HBO Hits (East) (H)" both carry hbo2.us. Two must agree and none
/// disagree, so one junk tag does not spread to its twins.
pub fn catalog_tvg_index(
    channels: &[CatalogChannel],
    feed_with_epg: &HashSet<String>,
) -> HashMap<String, String> {
    let mut tvgs: HashMap<String, Vec<String>> = HashMap::new();
    for ch in channels {
        if let (Some(key), Some(tvg)) = (
            normalize_channel_name(Some(&ch.name)),
            epg_id(ch.epg_channel_id.as_deref()),
        ) && is_us(&ch.name)
            && feed_with_epg.contains(&tvg)
        {
            tvgs.entry(key).or_default().push(tvg);
        }
    }
    tvgs.into_iter()
        .filter(|(_, ids)| ids.len() > 1 && ids.iter().all(|i| *i == ids[0]))
        .map(|(key, mut ids)| (key, ids.swap_remove(0)))
        .collect()
}

/// Resolve one catalog channel to the feed id whose EPG it shows: the
/// station's callsign, its own tvg-id, the tvg-id same-named streams carry,
/// then its name (renamed, as written, without a trailing "east"). None when
/// nothing passes `rejects`, and `Some("")` when the provider's own tag is
/// refused too: the guide lists COALESCE(epg_resolved_id, tvg-id), so a NULL
/// would put the refused tag back (2026-10-15 MY 38 Boston (WSBK) still showed
/// Al Jazeera Arabic). The provider's CINEBOX genre loops have no schedule.
pub fn resolve_epg_id(channel: &CatalogChannel, index: &EpgNameIndex) -> Option<String> {
    if CINEBOX.is_match(channel.name.as_bytes()) {
        return None;
    }
    let tvg = epg_id(channel.epg_channel_id.as_deref());
    let st = parse_station(&channel.name, tvg.as_deref());
    if st.callsign.is_some()
        && let Some(id) = by_callsign(&st, index, tvg.as_deref()).into_iter().next()
    {
        return Some(id);
    }
    let tag_refused = tvg.as_deref().is_some_and(|t| rejects(&st, t, None));
    let refused = || tag_refused.then(String::new);
    if let Some(t) = tvg
        .as_ref()
        .filter(|t| index.feed_with_epg.contains(*t) && !tag_refused)
    {
        return Some(t.clone()); // the provider's own tag
    }
    let Some(key) = st.key.as_deref() else {
        return refused();
    };
    // Some provider tags are junk (dubai.ae on WEAR), so a sibling's tvg-id
    // must start like the name.
    if st.us
        && let Some(sibling) = index.catalog_tvg.get(key)
        && id_stem(sibling).starts_with(head(key, 3))
        && !rejects(&st, sibling, None)
    {
        return Some(sibling.clone());
    }
    let mut keys = vec![key.to_string()];
    keys.push(match key.strip_suffix("east") {
        Some(k) if k.len() >= 3 => k.to_string(),
        _ => key.to_string(),
    });
    let renamed = keys.iter().map(|k| {
        RENAMES
            .iter()
            .fold(k.clone(), |acc, (from, to)| acc.replacen(from, to, 1))
    });
    for k in renamed.collect::<Vec<_>>().iter().chain(&keys) {
        let hit = index
            .name_to_feed_id
            .get(k)
            .or_else(|| st.us.then(|| index.us_name_to_feed_id.get(k)).flatten());
        if let Some(hit) = hit
            && !rejects(&st, hit, Some(k))
        {
            return Some(hit.clone()); // unambiguous name/alias
        }
    }
    refused()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn def(id: &str, names: &[&str]) -> ChannelDef {
        ChannelDef {
            id: id.into(),
            names: names.iter().map(|n| n.to_string()).collect(),
        }
    }
    fn ch(name: &str, tvg: Option<&str>) -> CatalogChannel {
        CatalogChannel {
            name: name.into(),
            epg_channel_id: tvg.map(String::from),
        }
    }
    fn norm(s: &str) -> Option<String> {
        normalize_channel_name(Some(s))
    }
    /// Every def has programmes, as in the TS veto tests.
    fn index(defs: &[ChannelDef], last_stop: &[(&str, &str)]) -> EpgNameIndex {
        let mut ix = build_epg_name_index(defs, defs.iter().map(|d| d.id.clone()).collect());
        ix.last_stop = last_stop
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        ix
    }
    fn resolve(name: &str, defs: &[ChannelDef], tvg: Option<&str>) -> Option<String> {
        resolve_epg_id(&ch(name, tvg), &index(defs, &[]))
    }
    fn some(s: &str) -> Option<String> {
        Some(s.to_string())
    }

    #[test]
    fn normalize_strips_country_prefix_quality_tags_punctuation() {
        assert_eq!(norm("US: ESPN"), some("espn"));
        assert_eq!(norm("UK FHD TNT Sport 1"), some("tntsport1"));
        assert_eq!(norm("HEVC: TNT Sports 1 FHD"), some("tntsports1"));
        assert_eq!(norm("US: CBS (New York)"), some("cbs"));
    }

    #[test]
    fn normalize_keeps_a_west_feed_and_the_usa_in_usa_network() {
        assert_eq!(norm("US: Oxygen (West)"), some("oxygenwest"));
        assert_eq!(norm("USA Network HD (Pacific)"), some("usanetworkwest"));
        assert_eq!(norm("US: USA NETWORK WEST"), some("usanetworkwest"));
        assert_eq!(norm("USA HGTV"), some("hgtv"));
    }

    #[test]
    fn normalize_returns_none_for_too_short_or_empty_names() {
        assert_eq!(norm(""), None);
        assert_eq!(normalize_channel_name(None), None);
        assert_eq!(norm("US: HD"), None);
    }

    #[test]
    fn lookaround_rewrites_match_the_js_regexes() {
        // Each expectation was checked against the JS regex in node.
        // (?<![a-z])(nets)(?:net(?:work)?)?(?:tv)?(?![a-z]), case-insensitive.
        assert_eq!(name_network("US: MyNetworkTV 9"), Some("my"));
        assert_eq!(name_network("US: CNBC"), Some("cnbc"));
        assert_eq!(name_network("Fox News"), Some("fox"));
        assert_eq!(name_network("Foxtel"), None);
        assert_eq!(name_network("MSNBC"), None);
        assert_eq!(name_network("US: ABC/NBC"), Some("abc"));
        // (?:(?<!mid|north|south)west|pacific)\W*$ without the last suffix.
        assert!(ends_with_coast("showtimewest.us"));
        assert!(ends_with_coast("hbo-pacific.us"));
        assert!(!ends_with_coast("fsmidwest.us"));
        assert!(!ends_with_coast("west.palm.us"));
        assert!(ends_with_coast("west"));
        assert!(ends_with_coast("x.west."));
        // \b(?!\s+network)\s+ after a bare country code.
        assert_eq!(strip_country_code("  usa network x"), "  usa network x");
        assert_eq!(strip_country_code("USA  HGTV"), "HGTV");
        assert_eq!(strip_country_code("us\u{a0}x"), "x");
    }

    fn espn_index() -> EpgNameIndex {
        let defs = [
            def("espn.us", &["ESPN", "US: ESPN", "ESPN (Backup)"]),
            def("cnn.us", &["CNN", "US: CNN"]),
            def("sportsa.uk", &["Sports TV"]),
            def("sportsb.uk", &["Sports TV"]),
            def("dead.us", &["Dead Channel"]),
        ];
        let with_epg = ["espn.us", "cnn.us", "sportsa.uk", "sportsb.uk"];
        build_epg_name_index(&defs, with_epg.iter().map(|s| s.to_string()).collect())
    }

    #[test]
    fn resolves_by_exact_tvg_then_unambiguous_name() {
        let ix = espn_index();
        let r = |name: &str, tvg: Option<&str>| resolve_epg_id(&ch(name, tvg), &ix);
        assert_eq!(r("whatever", Some("ESPN.us")), some("espn.us"));
        assert_eq!(r("US: ESPN", Some("espn2.us")), some("espn.us"));
        assert_eq!(r("HEVC CNN FHD", None), some("cnn.us"));
        assert_eq!(r("Sports TV", None), None, "ambiguous names are dropped");
        assert_eq!(
            r("Dead Channel", Some("dead.us")),
            None,
            "no programmes, never indexed"
        );
        assert_eq!(r("Totally Unknown XYZ", Some("nope.zz")), None);
    }

    #[test]
    fn lists_a_station_by_its_callsign_preferring_the_longest_schedule() {
        let ix = index(
            &[
                def("cbskztv.us", &["CBS 10 Corpus Christi"]),
                def("cbskztvcorpuschristitx.us", &[]),
            ],
            &[
                ("cbskztv.us", "2026-10-15T12:00:00.000Z"),
                ("cbskztvcorpuschristitx.us", "2026-10-17T23:00:00.000Z"),
            ],
        );
        assert_eq!(
            resolve_epg_id(
                &ch("US: CBS 10 Corpus Christi (KZTV)", Some("cbs10kztv.us")),
                &ix
            ),
            some("cbskztvcorpuschristitx.us")
        );
    }

    #[test]
    fn never_lists_another_markets_station_or_a_bare_network_id() {
        assert_eq!(
            resolve(
                "US: CBS 2 Pittsburgh (KDKA)",
                &[def("wcbs.us", &["CBS 2 Pittsburgh"])],
                None
            ),
            None
        );
        assert_eq!(
            resolve(
                "US: ABC 6 Philadelphia (WPVI)",
                &[def("abc5.us", &["ABC 6 Philadelphia"])],
                None
            ),
            None
        );
        assert_eq!(
            resolve(
                "US: FOX 13 Seattle (KCPQ)",
                &[def("fox.us", &["FOX 13 Seattle"])],
                None
            ),
            None
        );
        assert_eq!(
            resolve("US: MyTV (New Jersey)", &[def("mytv.us", &["MyTV"])], None),
            None
        );
        assert_eq!(
            resolve(
                "US: ABC 30 Fresno (KFSN)",
                &[def("abc30fresno.us", &[])],
                None
            ),
            some("abc30fresno.us")
        );
        assert_eq!(
            resolve("US: Telemundo", &[def("telemundo.us", &[])], None),
            some("telemundo.us")
        );
    }

    #[test]
    fn never_takes_another_stations_callsign_or_city() {
        let wjz = [
            def("wjz-dt.us_locals1", &["WJZ-DT"]),
            def("wjzy-dt.us_locals1", &["WJZY-DT"]),
        ];
        let b = "US: CBS 13 Baltimore (WJZ)";
        assert_eq!(
            resolve(b, &wjz, Some("wjz-dt.us_locals1")),
            some("wjz-dt.us_locals1")
        );
        assert_eq!(resolve(b, &wjz, None), some("wjz-dt.us_locals1"));
        assert_eq!(
            resolve(b, &[def("wjzy-dt.us_locals1", &["WJZY-DT"])], None),
            None
        );
        assert_eq!(
            resolve(b, &[def("cbswjzbaltimoremd.us", &[])], None),
            some("cbswjzbaltimoremd.us")
        );
        assert_eq!(
            resolve(
                "US: CBS 15 Fort Wayne (WANE)",
                &[def("cbsktvtdallasfortworthtx.us", &["CBS 15 Fort Wayne"])],
                None
            ),
            None
        );
        assert_eq!(
            resolve(
                "US: ABC 5 Oklahoma City (KOCO)",
                &[def("abckmbckansascitymo.us", &["ABC 5 Oklahoma City"])],
                None
            ),
            None
        );
        assert_eq!(
            resolve(
                "US: CBS 12 West Palm Beach (WPEC)",
                &[def("cbswestpalmbeach.us", &["CBS 12 West Palm Beach"])],
                None
            ),
            some("cbswestpalmbeach.us")
        );
    }

    #[test]
    fn takes_the_providers_tag_among_a_stations_ids_never_a_subchannel() {
        let wesh = [
            def("wesh-dt.us_locals1", &["WESH-DT"]),
            def("wesh-ld.us_locals1", &["WESH-LD"]),
        ];
        assert_eq!(
            resolve(
                "US: NBC 2 Orlando (WESH)",
                &wesh,
                Some("wesh-ld.us_locals1")
            ),
            some("wesh-ld.us_locals1")
        );
        assert_eq!(
            resolve(
                "US: FOX 7 Miami (WSVN)",
                &[def("wsvn-dt2.us_locals1", &["WSVN-DT2"])],
                None
            ),
            None
        );
    }

    #[test]
    fn never_crosses_networks_even_on_the_callsign() {
        assert_eq!(
            resolve(
                "US: NBC 2 Orlando (WESH)",
                &[def("abcorlando.us", &["NBC 2 Orlando"])],
                None
            ),
            None
        );
        assert_eq!(
            resolve(
                "US: NBC 3 Cleveland (WKYC)",
                &[def("cnbc.us", &["NBC 3 Cleveland"])],
                None
            ),
            None
        );
        assert_eq!(
            resolve(
                "US: Telemundo El Paso (KTSM)",
                &[def("nbcktsmelpasotx.us", &[])],
                None
            ),
            None
        );
    }

    #[test]
    fn does_not_honor_a_junk_tvg_id() {
        assert_eq!(
            resolve(
                "US: ABC 3 Mobile (WEAR)",
                &[def("dubai.ae", &["Dubai TV"])],
                Some("dubai.ae")
            ),
            some("")
        );
        assert_eq!(
            resolve(
                "US: News 12 New Jersey",
                &[def("dubai.ae", &[])],
                Some("dubai.ae")
            ),
            some("")
        );
        assert_eq!(
            resolve("US: MY 38 Boston (WSBK)", &[], Some("aljazeera.arabic.net")),
            some("")
        );
        assert_eq!(
            resolve(
                "US: Al Jazeera",
                &[def("aljazeera.english.net", &[])],
                Some("aljazeera.english.net")
            ),
            some("aljazeera.english.net")
        );
        assert_eq!(
            resolve(
                "US: GINX eSports",
                &[def("ginx.esports.gr", &["GINX eSports"])],
                Some("ginxesportstvcanada.ca")
            ),
            None
        );
    }

    #[test]
    fn keeps_the_coast_sub_brand_and_channel_number_of_the_name() {
        assert_eq!(
            resolve(
                "US: SHOWTIME WEST",
                &[def("showtime2west.us", &["Showtime West"])],
                None
            ),
            None
        );
        assert_eq!(
            resolve(
                "US: Oxygen (West)",
                &[def("oxygen.us", &["Oxygen"]), def("oxygenwest.us", &[])],
                None
            ),
            some("oxygenwest.us")
        );
        assert_eq!(
            resolve(
                "US: DISNEY JR WEST HD",
                &[def("disney.us", &["Disney Jr West"])],
                None
            ),
            None
        );
        assert_eq!(
            resolve(
                "US: SPECTRUM SPORTSNET DODGERS",
                &[
                    def("spectrumsportsnet.us", &["Spectrum SportsNet Dodgers"]),
                    def("spectrumsportsnetla.us", &[])
                ],
                None
            ),
            some("spectrumsportsnetla.us")
        );
        assert_eq!(
            resolve(
                "US: IndiePlex (West)",
                &[def("indieplex.us", &[])],
                Some("indieplex.us")
            ),
            some("indieplex.us")
        );
    }

    #[test]
    fn finds_renamed_channels_under_their_feed_id() {
        let defs = [
            def("hbohits.ph", &["HBO Hits"]),
            def("hbo2.us", &[]),
            def("hbo2west.us", &[]),
            def("showtime.us", &["Showtime BET"]),
            def("shoxbet.us", &[]),
            def("snews.us", &["Newsy"]),
            def("scrippsnews.us", &[]),
        ];
        assert_eq!(
            resolve("US: HBO Hits", &defs, Some("3778")),
            some("hbo2.us")
        );
        assert_eq!(
            resolve("US HBO Hits (West) (H)", &defs, None),
            some("hbo2west.us")
        );
        assert_eq!(resolve("US: SHOWTIME BET", &defs, None), some("shoxbet.us"));
        assert_eq!(
            resolve("US: NEWSY HD", &defs, Some("newsy.us")),
            some("scrippsnews.us")
        );
    }

    #[test]
    fn takes_the_tvg_id_twins_agree_on_and_the_us_id_of_a_global_brand() {
        let mut ix = index(
            &[
                def("cnbc.us", &[]),
                def("disneyjunior.us", &[]),
                def("disneyjunior.ca", &[]),
            ],
            &[],
        );
        ix.catalog_tvg = catalog_tvg_index(
            &[
                ch("US CNBC (A)", Some("cnbc.us")),
                ch("US: CNBC", Some("cnbc.us")),
                ch("US CNBC (S)", None),
            ],
            &ix.feed_with_epg,
        );
        assert_eq!(
            resolve_epg_id(&ch("US CNBC (S)", None), &ix),
            some("cnbc.us")
        );
        assert_eq!(
            resolve_epg_id(&ch("US: DISNEY JR EAST HD", None), &ix),
            some("disneyjunior.us")
        );
        assert_eq!(resolve_epg_id(&ch("CA: Disney Junior", None), &ix), None);
    }

    #[test]
    fn never_lists_the_providers_cinebox_genre_loops() {
        assert_eq!(
            resolve(
                "CINEBOX: ACTION",
                &[def("cinemaxactionwest.us", &["CINEBOX: ACTION"])],
                None
            ),
            None
        );
    }

    fn fixture(name: &str) -> Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name);
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }
    fn defs_of(v: &Value) -> Vec<ChannelDef> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|d| ChannelDef {
                id: d["id"].as_str().unwrap().into(),
                names: d["names"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|n| n.as_str().unwrap().into())
                    .collect(),
            })
            .collect()
    }
    fn opt(v: &Value) -> Option<String> {
        v.as_str().map(String::from)
    }

    /// Every guide row the 2026-10-15 audit judged, from the production
    /// snapshot: each index's answer matches the TS resolver's (goldens from
    /// gen-epg-goldens.ts), and the guide id it implies matches the audit.
    #[test]
    fn the_2026_10_15_audit_rows_resolve_as_the_ts_resolver_did() {
        let f = fixture("epg-resolve-2026-10-15.json");
        let golden = &fixture("epg-goldens.json")["resolved"];
        let provider_defs = defs_of(&f["provider"]);
        let mut provider = build_epg_name_index(
            &provider_defs,
            provider_defs.iter().map(|d| d.id.clone()).collect(),
        );
        let catalog: Vec<CatalogChannel> = f["catalog"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| ch(c["name"].as_str().unwrap(), c["epg_channel_id"].as_str()))
            .collect();
        provider.catalog_tvg = catalog_tvg_index(&catalog, &provider.feed_with_epg);
        provider.last_stop = f["provider"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| {
                (
                    d["id"].as_str().unwrap().into(),
                    d["lastStop"].as_str().unwrap().into(),
                )
            })
            .collect();
        let external_defs = defs_of(&f["external"]);
        let external = build_epg_name_index(
            &external_defs,
            external_defs.iter().map(|d| d.id.clone()).collect(),
        );
        let stored: HashSet<String> = f["external"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|d| d["stored"].as_bool() == Some(true))
            .map(|d| d["id"].as_str().unwrap().into())
            .collect();

        let want_tvg: HashMap<String, String> =
            serde_json::from_value(golden["catalog_tvg"].clone()).unwrap();
        assert_eq!(provider.catalog_tvg, want_tvg);
        for (name, want) in golden["normalized"].as_object().unwrap() {
            assert_eq!(norm(name), opt(want), "normalize {name:?}");
        }

        let cases = f["cases"].as_array().unwrap();
        assert!(cases.len() > 290);
        let mut wrong = Vec::new();
        for (c, g) in cases.iter().zip(golden["cases"].as_array().unwrap()) {
            assert_eq!(c["stream_id"], g["stream_id"]);
            let channel = ch(c["name"].as_str().unwrap(), c["tvg"].as_str());
            let p = resolve_epg_id(&channel, &provider);
            let e = resolve_epg_id(&channel, &external);
            let ids = callsign_ids(&channel, &external);
            let want_ids: Vec<String> = serde_json::from_value(g["callsign_ids"].clone()).unwrap();
            if (p.clone(), e.clone(), ids.clone())
                != (opt(&g["provider"]), opt(&g["external"]), want_ids)
            {
                wrong.push(format!(
                    "{}: provider {p:?} external {e:?} ids {ids:?} vs {g}",
                    c["name"]
                ));
            }
            // What the guide lists: the provider id, else the stored external
            // one, else the tvg-id unless the provider refused it.
            let p = p.filter(|s| !s.is_empty());
            let refused = resolve_epg_id(&channel, &provider).as_deref() == Some("");
            let e = if p.is_some() {
                None
            } else {
                e.filter(|id| stored.contains(id))
            };
            let id = p
                .or(e)
                .or_else(|| {
                    (!refused)
                        .then(|| epg_id(channel.epg_channel_id.as_deref()))
                        .flatten()
                })
                .filter(|id| provider.feed_with_epg.contains(id) || stored.contains(id));
            if id != opt(&c["expect"]) {
                wrong.push(format!(
                    "{}: guide {id:?} vs audit {}",
                    c["name"], c["expect"]
                ));
            }
        }
        assert!(wrong.is_empty(), "{wrong:#?}");
    }
}
