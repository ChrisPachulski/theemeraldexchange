//! MiniLM text embeddings: sentence-transformers' `all-MiniLM-L6-v2` pipeline
//! (BERT, attention-masked mean pooling, L2 normalisation) on candle, loading
//! `config.json`, `tokenizer.json` and `model.safetensors` from one directory
//! holding the pinned revision. `verify-embedding` checks it against the
//! torch baseline the Python image recorded.

use std::path::Path;

use candle_core::{DType, Device, Tensor};
use candle_nn::VarBuilder;
use candle_transformers::models::bert::{BertModel, Config as BertConfig};
use tokenizers::{PaddingParams, PaddingStrategy, Tokenizer, TruncationParams};

use crate::db::EMBED_DIM;
use crate::{Error, Result};

/// The model the vectors in exchange.db were built with; recorded in
/// ingest_state byte for byte as the Python featurizer wrote it.
pub const MODEL: &str = "sentence-transformers/all-MiniLM-L6-v2";
pub const MODEL_REVISION: &str = "c9745ed1d9f207416be6d2e6f8de32d1f16199bf";
/// sentence_bert_config.json's max_seq_length (tokenizer.json says 128).
const MAX_SEQ: usize = 256;
/// featurize.py's encode batch_size.
const BATCH: usize = 64;
/// The NAS runs Plex on 6 threads: the encoder gets two of them.
const THREADS: usize = 2;

fn embed_err(e: impl std::fmt::Display) -> Error {
    Error::Embed(e.to_string())
}

pub struct Embedder {
    model: BertModel,
    tokenizer: Tokenizer,
    pool: rayon::ThreadPool,
}

impl Embedder {
    pub fn load(dir: &Path) -> Result<Self> {
        let read = |name: &str| {
            std::fs::read(dir.join(name)).map_err(|e| embed_err(format!("{name}: {e}")))
        };
        let config: BertConfig = serde_json::from_slice(&read("config.json")?)
            .map_err(|e| embed_err(format!("config.json: {e}")))?;
        let vb = VarBuilder::from_buffered_safetensors(
            read("model.safetensors")?,
            DType::F32,
            &Device::Cpu,
        )
        .map_err(embed_err)?;
        let model = BertModel::load(vb, &config).map_err(embed_err)?;
        let mut tokenizer = Tokenizer::from_bytes(read("tokenizer.json")?).map_err(embed_err)?;
        // sentence-transformers calls the tokenizer with padding=True,
        // truncation="longest_first", max_length=256.
        tokenizer
            .with_truncation(Some(TruncationParams {
                max_length: MAX_SEQ,
                ..Default::default()
            }))
            .map_err(embed_err)?;
        tokenizer.with_padding(Some(PaddingParams {
            strategy: PaddingStrategy::BatchLongest,
            ..Default::default()
        }));
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(THREADS)
            .thread_name(|i| format!("embed-{i}"))
            .build()
            .map_err(embed_err)?;
        Ok(Self {
            model,
            tokenizer,
            pool,
        })
    }

    /// `model.encode(texts, normalize_embeddings=True)`: one unit vector per
    /// text. CPU-bound; async callers run it in spawn_blocking.
    pub fn encode(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        // Everything rayon-parallel (tokenizing, gemm) runs on our pool.
        self.pool.install(|| {
            let mut out = Vec::with_capacity(texts.len());
            for batch in texts.chunks(BATCH) {
                out.extend(self.encode_batch(batch)?);
            }
            Ok(out)
        })
    }

    fn encode_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        // sentence-transformers strips each text before tokenizing.
        let inputs: Vec<&str> = texts.iter().map(|t| t.trim()).collect();
        let enc = self
            .tokenizer
            .encode_batch(inputs, true)
            .map_err(embed_err)?;
        let (rows, cols) = (enc.len(), enc.first().map_or(0, |e| e.len()));
        let flat = |f: fn(&tokenizers::Encoding) -> &[u32]| -> Vec<u32> {
            enc.iter().flat_map(|e| f(e).iter().copied()).collect()
        };
        let mask = flat(tokenizers::Encoding::get_attention_mask);
        let tensor = |v: Vec<u32>| Tensor::from_vec(v, (rows, cols), &Device::Cpu);
        let hidden = self
            .model
            .forward(
                &tensor(flat(tokenizers::Encoding::get_ids)).map_err(embed_err)?,
                &tensor(flat(tokenizers::Encoding::get_type_ids)).map_err(embed_err)?,
                Some(&tensor(mask.clone()).map_err(embed_err)?),
            )
            .and_then(|h| h.to_vec3::<f32>())
            .map_err(embed_err)?;
        Ok(hidden
            .iter()
            .zip(mask.chunks(cols.max(1)))
            .map(|(tokens, mask)| mean_pool_normalized(tokens, mask))
            .collect())
    }
}

/// Pooling (sum of masked token vectors / max(token count, 1e-9)) then
/// Normalize (x / max(||x||, 1e-12)).
fn mean_pool_normalized(tokens: &[Vec<f32>], mask: &[u32]) -> Vec<f32> {
    let mut sum = vec![0f32; EMBED_DIM];
    let mut count = 0f32;
    for (tok, &m) in tokens.iter().zip(mask) {
        if m != 0 {
            count += 1.0;
            for (s, v) in sum.iter_mut().zip(tok) {
                *s += v;
            }
        }
    }
    let count = count.max(1e-9);
    sum.iter_mut().for_each(|s| *s /= count);
    normalize(&mut sum, 1e-12);
    sum
}

/// Divide by the L2 norm (summed in f64) when it exceeds `floor`, else by `floor`.
fn normalize(v: &mut [f32], floor: f32) {
    let n = l2_norm(v).max(floor);
    v.iter_mut().for_each(|x| *x /= n);
}

pub(crate) fn l2_norm(v: &[f32]) -> f32 {
    v.iter()
        .map(|&x| f64::from(x) * f64::from(x))
        .sum::<f64>()
        .sqrt() as f32
}

const MAX_ELEMENT_DELTA: f32 = 1e-4;
const NORM_TOLERANCE: f32 = 1e-5;
const BASELINE_SHA256: &str = "c62435ea899eddc1149eff4c49e078e4781381fcabcce472054129e39f48630b";

/// `eex-recommender verify-embedding <baseline.json>` (was
/// scripts/verify_embedding_runtime.py): the model in `model_dir` reproduces
/// the torch baseline (max element delta 1e-4, unit norms within 1e-5, the
/// same top-3 neighbours), and featurize persists a unit vector into a fresh
/// migrated DB. Returns the status JSON the script printed, minus its torch
/// and setuptools versions.
pub async fn verify_baseline(model_dir: &Path, baseline: &Path) -> Result<serde_json::Value> {
    use base64::Engine as _;
    use sha2::Digest as _;
    let require = |ok: bool, msg: String| if ok { Ok(()) } else { Err(Error::Invalid(msg)) };

    let raw = std::fs::read(baseline).map_err(|e| embed_err(format!("{baseline:?}: {e}")))?;
    let fx: serde_json::Value =
        serde_json::from_slice(&raw).map_err(|e| embed_err(format!("baseline: {e}")))?;
    require(
        fx["schema"] == 1,
        "unsupported embedding baseline schema".into(),
    )?;
    require(
        fx["dtype"] == "float32-le",
        "baseline must contain little-endian float32".into(),
    )?;
    require(fx["model"] == MODEL, "baseline model name changed".into())?;
    require(
        fx["model_revision"] == MODEL_REVISION,
        "baseline model revision changed".into(),
    )?;
    let payload = base64::engine::general_purpose::STANDARD
        .decode(fx["embeddings_base64"].as_str().unwrap_or_default())
        .map_err(|e| embed_err(format!("embeddings_base64: {e}")))?;
    let digest: String = sha2::Sha256::digest(&payload)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    require(
        fx["embeddings_sha256"] == BASELINE_SHA256,
        "baseline embedding digest changed".into(),
    )?;
    require(
        digest == BASELINE_SHA256,
        "baseline embedding payload changed".into(),
    )?;
    let texts: Vec<String> = serde_json::from_value(fx["texts"].clone())
        .map_err(|e| embed_err(format!("texts: {e}")))?;
    let want: Vec<f32> = payload
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect();
    let want_top3: Vec<Vec<usize>> = serde_json::from_value(fx["top3_neighbors"].clone())
        .map_err(|e| embed_err(format!("top3_neighbors: {e}")))?;

    let embedder = std::sync::Arc::new(Embedder::load(model_dir)?);
    let current = {
        let (e, t) = (embedder.clone(), texts.clone());
        tokio::task::spawn_blocking(move || e.encode(&t))
            .await
            .map_err(embed_err)??
    };
    require(
        want.len() == texts.len() * EMBED_DIM
            && fx["shape"] == serde_json::json!([texts.len(), EMBED_DIM]),
        format!(
            "embedding shape [{}, {EMBED_DIM}] != {}",
            texts.len(),
            fx["shape"]
        ),
    )?;
    let max_delta = current
        .iter()
        .flatten()
        .zip(&want)
        .map(|(a, b)| (a - b).abs())
        .fold(0f32, f32::max);
    require(
        max_delta <= MAX_ELEMENT_DELTA,
        format!("maximum embedding element delta {max_delta:e} exceeds {MAX_ELEMENT_DELTA}"),
    )?;
    let max_norm_error = current
        .iter()
        .map(|v| (l2_norm(v) - 1.0).abs())
        .fold(0f32, f32::max);
    require(
        max_norm_error <= NORM_TOLERANCE,
        format!("maximum normalized-embedding error {max_norm_error:e} exceeds {NORM_TOLERANCE}"),
    )?;
    let top3 = top3_neighbors(&current);
    require(
        top3 == want_top3,
        format!("top-3 neighbor ranking changed: current={top3:?} baseline={want_top3:?}"),
    )?;

    let (migrations, processed, vec_rows, norm) = persistence_smoke(embedder, &texts[0]).await?;
    Ok(serde_json::json!({
        "status": "ok",
        "baseline_torch": fx["baseline_torch"],
        "model": MODEL,
        "model_revision": MODEL_REVISION,
        "max_element_delta": max_delta,
        "top3_stable": true,
        "migrations_applied": migrations,
        "rows_featurized": processed,
        "title_vec_rows": vec_rows,
        "persisted_norm": norm,
    }))
}

/// Per row, the three most similar other rows by dot product, ties by index.
fn top3_neighbors(vs: &[Vec<f32>]) -> Vec<Vec<usize>> {
    let dot = |a: &[f32], b: &[f32]| a.iter().zip(b).map(|(x, y)| x * y).sum::<f32>();
    (0..vs.len())
        .map(|i| {
            let mut others: Vec<(usize, f32)> = (0..vs.len())
                .filter(|&j| j != i)
                .map(|j| (j, dot(&vs[i], &vs[j])))
                .collect();
            others.sort_by(|a, b| b.1.total_cmp(&a.1));
            others.into_iter().take(3).map(|(j, _)| j).collect()
        })
        .collect()
}

/// The script's persistence check: a fresh migrated DB, one synthetic title,
/// featurize with limit 1, then one unit vector in title_features and title_vec.
async fn persistence_smoke(
    embedder: std::sync::Arc<Embedder>,
    overview: &str,
) -> Result<(usize, usize, i64, f32)> {
    let dir = tempfile::Builder::new()
        .prefix("eex-embedding-gate-")
        .tempdir()
        .map_err(embed_err)?;
    let pool = crate::db::open(&dir.path().join("exchange.db")).await?;
    let migrations: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM schema_migrations")
        .fetch_one(&pool)
        .await?;
    if migrations == 0 {
        return Err(Error::Invalid(
            "fresh database applied zero SQL migrations".into(),
        ));
    }
    sqlx::query(
        "INSERT INTO titles(tmdb_id, kind, title, overview, fetched_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(900_000_001_i64)
    .bind("movie")
    .bind("Synthetic Runtime Gate")
    .bind(overview)
    .bind(
        chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S+00:00")
            .to_string(),
    )
    .execute(&pool)
    .await?;
    let processed = crate::featurize::run(&pool, embedder, Some(1)).await?;
    if processed != 1 {
        return Err(Error::Invalid(format!(
            "featurizer processed {processed} rows instead of 1"
        )));
    }
    let (blob, dim): (Vec<u8>, i64) =
        sqlx::query_as("SELECT embedding, dim FROM title_features WHERE tmdb_id = ? AND kind = ?")
            .bind(900_000_001_i64)
            .bind("movie")
            .fetch_one(&pool)
            .await?;
    let vec_rows: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM title_vec WHERE rowid = ? AND kind = ?")
            .bind(900_000_001_i64)
            .bind("movie")
            .fetch_one(&pool)
            .await?;
    pool.close().await;
    let stored = crate::db::deserialize_f32(&blob, Some(dim as usize))?;
    let norm = l2_norm(&stored);
    let ok = vec_rows == 1
        && stored.len() == EMBED_DIM
        && stored.iter().all(|x| x.is_finite())
        && (norm - 1.0).abs() <= NORM_TOLERANCE;
    if !ok {
        return Err(Error::Invalid(format!(
            "persisted vector check failed: title_vec rows {vec_rows}, dim {}, norm {norm}",
            stored.len()
        )));
    }
    Ok((migrations as usize, processed, vec_rows, norm))
}

/// The pinned model directory for the model-backed tests: `EEX_MINILM_DIR`
/// (e.g. the HF cache snapshot of revision c9745ed). None skips them.
#[cfg(test)]
pub(crate) fn test_model_dir() -> Option<std::path::PathBuf> {
    let dir = std::path::PathBuf::from(std::env::var_os("EEX_MINILM_DIR")?);
    if dir.join("model.safetensors").is_file() {
        Some(dir)
    } else {
        eprintln!("EEX_MINILM_DIR has no model.safetensors; skipping");
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pooling_ignores_padding_and_normalises() {
        let tokens = vec![
            vec![3.0; EMBED_DIM],
            vec![1.0; EMBED_DIM],
            vec![99.0; EMBED_DIM],
        ];
        let v = mean_pool_normalized(&tokens, &[1, 1, 0]);
        let want = 1.0 / (EMBED_DIM as f32).sqrt();
        assert!(v.iter().all(|x| (x - want).abs() < 1e-7));
        // An all-zero vector stays zero (the 1e-12 floor), as in torch.
        assert!(
            mean_pool_normalized(&tokens, &[0, 0, 0])
                .iter()
                .all(|&x| x == 0.0)
        );
    }

    #[test]
    fn top3_breaks_ties_by_index() {
        let vs = vec![
            vec![1.0, 0.0],
            vec![1.0, 0.0],
            vec![1.0, 0.0],
            vec![0.0, 1.0],
        ];
        assert_eq!(top3_neighbors(&vs)[0], vec![1, 2, 3]);
    }

    /// The done-when gate: the pinned model reproduces the torch 2.12 baseline
    /// (and featurize persists a unit vector). Skips without EEX_MINILM_DIR.
    #[tokio::test]
    async fn matches_torch_baseline() {
        let Some(dir) = test_model_dir() else { return };
        let baseline = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/torch_2_12_embedding_baseline.json");
        let report = verify_baseline(&dir, &baseline).await.unwrap();
        assert_eq!(report["status"], "ok");
        assert_eq!(report["rows_featurized"], 1);
        eprintln!("{report}");
    }
}
