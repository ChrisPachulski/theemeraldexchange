//! The canary: "scooby doo" on 2026-10-18. Radarr's and Sonarr's own lookup
//! rows and the library's Scooby-Doo rows, both from prod, cut to the fields
//! the ranking reads.

use std::sync::Arc;

use serde_json::{Value, json};

use super::super::fake::{Fake, Route};
use super::super::shared::Timings;
use super::{is_id_term, rank, words};
use crate::testutil::*;

fn fixture() -> Value {
    serde_json::from_str(include_str!("../../../tests/fixtures/search-scooby.json")).unwrap()
}

fn rows(v: &Value) -> Vec<Value> {
    v.as_array().unwrap().clone()
}

fn ids(rows: &[Value], key: &str) -> Vec<i64> {
    rows.iter().filter_map(|r| r[key].as_i64()).collect()
}

fn titles(rows: &[Value]) -> Vec<&str> {
    rows.iter().map(|r| r["title"].as_str().unwrap()).collect()
}

/// Library rows that are not Scooby-Doo, so a match has to be earned.
fn with_noise(mut library: Vec<Value>, key: &str) -> Vec<Value> {
    for (i, t) in ["Doctor Who", "The Office", "Scrubs"].iter().enumerate() {
        library.push(json!({ "id": 9000 + i, "title": t, "year": 2005, key: 9000 + i }));
    }
    library
}

#[test]
fn every_owned_scooby_movie_leads_the_movie_search() {
    let f = fixture();
    let library = rows(&f["radarr"]["library"]);
    let owned = ids(&library, "tmdbId");
    // Before: the lookup alone carries 3 of the 9 owned movies.
    let lookup = rows(&f["radarr"]["lookup"]);
    assert_eq!(
        ids(&lookup, "tmdbId")
            .iter()
            .filter(|i| owned.contains(i))
            .count(),
        3
    );

    let out = rank(
        "scooby doo",
        lookup,
        &with_noise(library, "tmdbId"),
        "tmdbId",
    );
    let head = ids(&out[..9], "tmdbId");
    assert!(
        owned.iter().all(|i| head.contains(i)),
        "owned not first: {:?}",
        titles(&out)
    );
    assert!(
        !titles(&out)
            .iter()
            .any(|t| ["Doctor Who", "The Office", "Scrubs"].contains(t))
    );
    let unique: std::collections::HashSet<i64> = ids(&out, "tmdbId").into_iter().collect();
    assert_eq!(unique.len(), out.len(), "a title appears twice");
}

#[test]
fn owned_shows_lead_and_posterless_stubs_sink_in_the_tv_search() {
    let f = fixture();
    let library = rows(&f["sonarr"]["library"]);
    let lookup = rows(&f["sonarr"]["lookup"]);
    // Before: a posterless 2008 stub led the list.
    assert_eq!(lookup[0]["title"], "Scooby Doo");
    assert!(lookup[0]["images"].as_array().unwrap().is_empty());

    let out = rank(
        "scooby doo",
        lookup,
        &with_noise(library.clone(), "tvdbId"),
        "tvdbId",
    );
    let t = titles(&out);
    assert_eq!(t[0], "Scooby-Doo, Where Are You!", "{t:?}");
    let head = ids(&out[..3], "tvdbId");
    assert!(
        ids(&library, "tvdbId").iter().all(|i| head.contains(i)),
        "{t:?}"
    );
    // Nothing is lost: posterless rows stay addable but sink to the end,
    // behind a lookup row that matches no query word.
    assert_eq!(out.len(), 20, "{t:?}");
    let posterless = |r: &Value| r["images"].as_array().unwrap().is_empty();
    let first_bare = out.iter().position(posterless).unwrap();
    assert!(out[first_bare..].iter().all(posterless), "{t:?}");
    assert_eq!(t[first_bare - 1], "Syl\u{2019}s Oude Doos", "{t:?}");
}

#[test]
fn punctuation_and_spacing_never_decide_a_match() {
    let lib = |t: &str| vec![json!({ "id": 1, "title": t, "tmdbId": 1 })];
    for (q, title) in [
        ("scooby doo", "Scooby-Doo!"),
        ("scoobydoo", "Scooby-Doo!"),
        ("spiderman", "Spider-Man: Homecoming"),
        ("whats new scooby", "What's New, Scooby-Doo?"),
        ("SCOOB", "Scoob!"),
        ("scooby-doo", "Scooby Doo and Guess Who?"),
        ("law and order", "Law & Order"),
        ("law & order", "Law and Order"),
    ] {
        assert_eq!(
            rank(q, vec![], &lib(title), "tmdbId").len(),
            1,
            "{q:?} missed {title:?}"
        );
    }
    assert!(rank("batman", vec![], &lib("Scooby-Doo!"), "tmdbId").is_empty());
    assert!(
        rank("us", vec![], &lib("Music and Lyrics"), "tmdbId").is_empty(),
        "a short query matches word starts only"
    );
    assert_eq!(
        words("What\u{2019}s New, Scooby-Doo?"),
        ["whats", "new", "scooby", "doo"]
    );
    assert!(is_id_term("tvdb:12345") && is_id_term("imdb:tt0105946") && !is_id_term("scooby doo"));
}

#[tokio::test]
async fn the_route_ranks_and_fetches_the_library_once_per_ttl() {
    let f = fixture();
    let fake = Fake::start(vec![
        Route::new(
            "GET",
            "/radarr/api/v3/movie/lookup",
            200,
            &f["radarr"]["lookup"],
        ),
        Route::new("GET", "/radarr/api/v3/movie", 200, &f["radarr"]["library"]),
    ])
    .await;
    let dir = tempfile::tempdir().unwrap();
    let radarr = format!("{}/radarr", fake.url);
    let mut st = state_in(&dir, &[("RADARR_URL", &radarr), ("RADARR_API_KEY", "k")]).await;
    st.arr = Arc::new(super::super::ArrState::new(&st.config, Timings::default()));
    let cookie = member(&st, ADMIN, "admin", "admin").await;
    let app = crate::router(st);

    for _ in 0..2 {
        let r = send(
            &app,
            json_req(
                "GET",
                "/api/radarr/api/v3/movie/lookup?term=scooby%20doo",
                Some(&cookie),
                None,
            ),
        )
        .await;
        assert_eq!(r.status, 200, "{}", r.body);
        let out: Vec<Value> = serde_json::from_str(&r.body).unwrap();
        let owned = ids(&rows(&f["radarr"]["library"]), "tmdbId");
        assert!(
            owned.iter().all(|i| ids(&out[..9], "tmdbId").contains(i)),
            "{:?}",
            titles(&out)
        );
    }
    assert_eq!(fake.count("GET", "/radarr/api/v3/movie/lookup"), 2);
    assert_eq!(fake.count("GET", "/radarr/api/v3/movie"), 1);

    // An id term is passed through untouched, with no library fetch.
    let r = send(
        &app,
        json_req(
            "GET",
            "/api/radarr/api/v3/movie/lookup?term=tmdb:1",
            Some(&cookie),
            None,
        ),
    )
    .await;
    assert_eq!(r.status, 200);
    assert_eq!(
        serde_json::from_str::<Value>(&r.body).unwrap(),
        f["radarr"]["lookup"]
    );
}
