//! The templated "why this" pill (`app/reasons.py`); no LLM.

use std::collections::HashSet;

use crate::context::{Candidate, TitleRow, UserContext, norm};

/// TMDB genre names, movies and TV (lookups are by id).
const TMDB_GENRES: &[(i64, &str)] = &[
    (28, "action"),
    (12, "adventure"),
    (16, "animation"),
    (35, "comedy"),
    (80, "crime"),
    (99, "documentary"),
    (18, "drama"),
    (10751, "family"),
    (14, "fantasy"),
    (36, "history"),
    (27, "horror"),
    (10402, "music"),
    (9648, "mystery"),
    (10749, "romance"),
    (878, "sci-fi"),
    (10770, "tv movie"),
    (53, "thriller"),
    (10752, "war"),
    (37, "western"),
    (10759, "action & adventure"),
    (10762, "kids"),
    (10763, "news"),
    (10764, "reality"),
    (10765, "sci-fi & fantasy"),
    (10766, "soap"),
    (10767, "talk"),
    (10768, "war & politics"),
];

/// The first of the title's genres that has a name.
pub fn genre_label(genre_ids: &[i64]) -> Option<&'static str> {
    genre_ids
        .iter()
        .find_map(|g| TMDB_GENRES.iter().find(|(id, _)| id == g).map(|(_, n)| *n))
}

/// "matches Severance, Andor" (at most two neighbors, no years).
pub fn personalized_reason(cand: &Candidate, neighbors: &[TitleRow]) -> String {
    if neighbors.is_empty() {
        return match genre_label(&cand.title.genre_ids) {
            Some(g) => format!("new {g} pick"),
            None => "based on your taste".into(),
        };
    }
    let parts: Vec<&str> = neighbors.iter().take(2).map(|n| n.title.as_str()).collect();
    format!("matches {}", parts.join(", "))
}

pub fn discover_reason(cand: &Candidate) -> String {
    let g = genre_label(&cand.title.genre_ids);
    // Python truthiness: a year of 0 counts as none.
    match (g, cand.title.year.filter(|y| *y != 0)) {
        (Some(g), Some(y)) => format!("{y} {g} you haven't seen"),
        (Some(g), None) => format!("{g} you might've missed"),
        (None, _) => "outside your usual lane".into(),
    }
}

pub fn trending_reason(title: &TitleRow) -> String {
    match genre_label(&title.genre_ids) {
        Some(g) => format!("trending in {g}"),
        None => "trending now".into(),
    }
}

/// The k library/liked titles whose embeddings are closest to the candidate.
/// A title in both pools is one pool row (its library embedding), so the pill
/// never reads "matches X, X".
pub fn neighbors_for(cand: &Candidate, ctx: &UserContext, k: usize) -> Vec<TitleRow> {
    let mut seen = HashSet::new();
    let pool: Vec<(i64, &Vec<f32>)> = [&ctx.library_embeddings, &ctx.liked_embeddings]
        .into_iter()
        .flat_map(|e| e.ids.iter().copied().zip(&e.rows))
        .filter(|(tid, _)| seen.insert(*tid))
        .collect();
    if pool.is_empty() {
        return Vec::new();
    }
    // float32 throughout, as numpy computed it.
    let cn = norm(&cand.embedding).max(1e-9);
    let c: Vec<f32> = cand.embedding.iter().map(|x| x / cn).collect();
    let mut sims: Vec<(usize, f32)> = pool
        .iter()
        .enumerate()
        .map(|(i, (_, emb))| {
            let n = norm(emb).max(1e-9);
            (i, emb.iter().zip(&c).map(|(a, b)| (a / n) * b).sum())
        })
        .collect();
    // argsort()[::-1]: descending, a tie going to the later row.
    sims.sort_by(|a, b| b.1.total_cmp(&a.1).then(b.0.cmp(&a.0)));
    sims.into_iter()
        .take(k)
        .filter_map(|(i, _)| {
            let tid = pool[i].0;
            ctx.library_titles
                .get(&tid)
                .or_else(|| ctx.liked_titles.get(&tid))
                .cloned()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::Embeddings;

    fn title(tmdb_id: i64, name: &str) -> TitleRow {
        TitleRow {
            tmdb_id,
            kind: "tv",
            title: name.into(),
            year: Some(2022),
            poster_path: None,
            overview: None,
            popularity: 1.0,
            vote_average: Some(8.0),
            genre_ids: vec![18],
        }
    }

    type Rows = Vec<(TitleRow, Vec<f32>)>;

    fn ctx(library: Rows, liked: Rows) -> UserContext {
        let split = |rows: &Rows| Embeddings {
            ids: rows.iter().map(|(t, _)| t.tmdb_id).collect(),
            rows: rows.iter().map(|(_, v)| v.clone()).collect(),
        };
        UserContext {
            kind: "tv",
            library_ids: library.iter().map(|(t, _)| t.tmdb_id).collect(),
            library_embeddings: split(&library),
            library_titles: library
                .iter()
                .map(|(t, _)| (t.tmdb_id, t.clone()))
                .collect(),
            liked_ids: liked.iter().map(|(t, _)| t.tmdb_id).collect(),
            liked_embeddings: split(&liked),
            liked_titles: liked.iter().map(|(t, _)| (t.tmdb_id, t.clone())).collect(),
            ..Default::default()
        }
    }

    fn candidate() -> Candidate {
        Candidate {
            title: title(999, "Candidate Show"),
            embedding: vec![1.0, 0.0, 0.0],
        }
    }

    fn ids(rows: &[TitleRow]) -> Vec<i64> {
        rows.iter().map(|t| t.tmdb_id).collect()
    }

    // recommender/tests/test_reasons_neighbors_dedupe.py, case for case.
    #[test]
    fn watched_and_liked_title_is_cited_once() {
        let c = ctx(
            vec![
                (title(100, "Severance"), vec![1.0, 0.02, 0.0]),
                (title(200, "Andor"), vec![0.9, 0.3, 0.0]),
            ],
            vec![(title(100, "Severance"), vec![1.0, 0.01, 0.0])],
        );
        assert_eq!(ids(&neighbors_for(&candidate(), &c, 2)), [100, 200]);
    }

    #[test]
    fn personalized_reason_cites_two_distinct_titles() {
        let c = ctx(
            vec![
                (title(100, "Severance"), vec![1.0, 0.02, 0.0]),
                (title(200, "Andor"), vec![0.9, 0.3, 0.0]),
            ],
            vec![(title(100, "Severance"), vec![1.0, 0.01, 0.0])],
        );
        let cand = candidate();
        let reason = personalized_reason(&cand, &neighbors_for(&cand, &c, 2));
        assert_eq!(reason, "matches Severance, Andor");
    }

    #[test]
    fn liked_only_title_is_still_eligible() {
        let c = ctx(
            vec![(title(100, "Severance"), vec![1.0, 0.02, 0.0])],
            vec![
                (title(100, "Severance"), vec![1.0, 0.01, 0.0]),
                (title(300, "Silo"), vec![0.95, 0.2, 0.0]),
            ],
        );
        assert_eq!(ids(&neighbors_for(&candidate(), &c, 2)), [100, 300]);
    }

    #[test]
    fn reason_templates() {
        let mut t = title(1, "X");
        t.genre_ids = vec![99999, 35, 18];
        let cand = Candidate {
            title: t.clone(),
            embedding: vec![],
        };
        assert_eq!(genre_label(&t.genre_ids), Some("comedy"));
        assert_eq!(personalized_reason(&cand, &[]), "new comedy pick");
        assert_eq!(discover_reason(&cand), "2022 comedy you haven't seen");
        assert_eq!(trending_reason(&t), "trending in comedy");
        let mut none = t.clone();
        none.year = Some(0);
        let c0 = Candidate {
            title: none,
            embedding: vec![],
        };
        assert_eq!(discover_reason(&c0), "comedy you might've missed");
        t.genre_ids = vec![99999];
        let c1 = Candidate {
            title: t.clone(),
            embedding: vec![],
        };
        assert_eq!(personalized_reason(&c1, &[]), "based on your taste");
        assert_eq!(discover_reason(&c1), "outside your usual lane");
        assert_eq!(trending_reason(&t), "trending now");
    }
}
