//! Artwork core: decode (EXIF orientation applied), resize to a fixed width
//! ladder, encode lossy WebP, compute blurhash placeholders, and keep the
//! resized variants in a disk-capped LRU cache under `<data>/images/cache`.
//! TMDB originals are fetched once into `<data>/images/orig/tmdb/<file>`,
//! under the same cap, with a negative cache in the `images` table.
//!
//! CPU work runs through [`Pool`], a constant 2-permit gate around
//! `spawn_blocking`, so image decoding never takes more than two of the NAS's
//! six threads away from Plex. Decodes also share a memory budget
//! ([`MEMORY_BUDGET_MIB`]) sized against media-core's 768m container limit:
//! a source is opened only inside the pool, priced from its header, and
//! decoded once its price fits.

use std::collections::HashMap;
use std::io::BufReader;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, SystemTime};

use fast_image_resize::Resizer;
use image::error::{LimitError, LimitErrorKind};
use image::metadata::Orientation;
use image::{DynamicImage, ImageDecoder, ImageError, ImageReader};
use tokio::sync::Semaphore;

/// Served widths. A request snaps up to the next rung so the cache holds at
/// most seven variants per image, whatever widths clients ask for.
pub const WIDTHS: [u32; 7] = [92, 185, 342, 500, 780, 1280, 1920];
/// Concurrent CPU jobs. Constant on purpose: Plex keeps the other cores.
pub const POOL_PERMITS: usize = 2;
/// Lossy WebP quality.
pub const WEBP_QUALITY: f32 = 80.0;
/// Memory all in-flight decodes may hold together, in MiB. A decode costs its
/// file plus three times its decoded size (pixels, plus a progressive JPEG's
/// coefficient planes); one that costs more than the whole budget is refused.
// ponytail: refuses sources past ~27 MP RGB (24 MP cameras fit). Raise the
// budget with media-core's mem_limit if larger photos need thumbnails.
pub const MEMORY_BUDGET_MIB: u32 = 256;
/// Largest source file opened at all: a JPEG decoder holds its whole file,
/// and it is read before the decode is priced.
pub const MAX_SOURCE_BYTES: u64 = 64 << 20;

#[derive(Debug, thiserror::Error)]
pub enum ArtworkError {
    #[error("decode: {0}")]
    Decode(#[from] image::ImageError),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("resize: {0}")]
    Resize(String),
    #[error("encode: {0}")]
    Encode(String),
    #[error("blurhash: {0}")]
    Blurhash(String),
    #[error("pool: {0}")]
    Pool(String),
}

fn too_large() -> ArtworkError {
    ArtworkError::Decode(ImageError::Limits(LimitError::from_kind(
        LimitErrorKind::InsufficientMemory,
    )))
}

/// Open `path` for decoding (any supported format, sniffed from content) and
/// price the decode in MiB of [`MEMORY_BUDGET_MIB`]. Only the header is
/// parsed, except that a JPEG decoder reads its whole file here.
pub fn open(path: &Path) -> Result<(impl ImageDecoder, u32), ArtworkError> {
    let size = std::fs::metadata(path)?.len();
    if size > MAX_SOURCE_BYTES {
        return Err(too_large());
    }
    let decoder = ImageReader::new(BufReader::new(std::fs::File::open(path)?))
        .with_guessed_format()?
        .into_decoder()?;
    let cost = size
        .saturating_add(decoder.total_bytes().saturating_mul(3))
        .div_ceil(1 << 20);
    if cost > u64::from(MEMORY_BUDGET_MIB) {
        return Err(too_large());
    }
    Ok((decoder, cost as u32))
}

/// Finish an [`open`]ed decode: the image as stored plus its EXIF
/// orientation, which [`variant`] and [`describe`] apply to their small
/// output instead of copying the full-size pixels.
pub fn decode(mut decoder: impl ImageDecoder) -> Result<(DynamicImage, Orientation), ArtworkError> {
    let orientation = decoder.orientation()?;
    Ok((DynamicImage::from_decoder(decoder)?, orientation))
}

/// Whether `orientation` turns the image a quarter, swapping width and height.
fn swaps_axes(orientation: Orientation) -> bool {
    matches!(
        orientation,
        Orientation::Rotate90
            | Orientation::Rotate270
            | Orientation::Rotate90FlipH
            | Orientation::Rotate270FlipH
    )
}

/// Width and height as displayed once `orientation` is applied.
fn oriented_dims(img: &DynamicImage, orientation: Orientation) -> (u32, u32) {
    if swaps_axes(orientation) {
        (img.height(), img.width())
    } else {
        (img.width(), img.height())
    }
}

/// The smallest ladder width at or above `w` (the largest rung beyond it).
pub fn snap_width(w: u32) -> u32 {
    WIDTHS
        .iter()
        .copied()
        .find(|&rung| rung >= w)
        .unwrap_or(WIDTHS[WIDTHS.len() - 1])
}

/// Resize to the snapped display width (never upscaling), apply
/// `orientation`, and encode lossy WebP. The resize reads the decoded pixels
/// in place, whatever their type; only the small result is converted.
pub fn variant(
    img: &DynamicImage,
    orientation: Orientation,
    w: u32,
) -> Result<Vec<u8>, ArtworkError> {
    let (src_w, src_h) = oriented_dims(img, orientation);
    if src_w == 0 || src_h == 0 {
        return Err(ArtworkError::Resize("empty image".into()));
    }
    let dst_w = snap_width(w).min(src_w);
    let dst_h = ((u64::from(src_h) * u64::from(dst_w) + u64::from(src_w) / 2) / u64::from(src_w))
        .max(1) as u32;

    let (rw, rh) = if swaps_axes(orientation) {
        (dst_h, dst_w)
    } else {
        (dst_w, dst_h)
    };
    let mut small = DynamicImage::new(rw, rh, img.color());
    Resizer::new()
        .resize(img, &mut small, None)
        .map_err(|e| ArtworkError::Resize(e.to_string()))?;
    small.apply_orientation(orientation);

    let webp = if img.color().has_alpha() {
        webp::Encoder::from_rgba(&small.into_rgba8(), dst_w, dst_h)
            .encode_simple(false, WEBP_QUALITY)
            .map(|m| m.to_vec())
    } else {
        webp::Encoder::from_rgb(&small.into_rgb8(), dst_w, dst_h)
            .encode_simple(false, WEBP_QUALITY)
            .map(|m| m.to_vec())
    };
    webp.map_err(|e| ArtworkError::Encode(format!("{e:?}")))
}

/// A 4x3-component blurhash of the image, computed on a 32px thumbnail.
pub fn blurhash(img: &DynamicImage) -> Result<String, ArtworkError> {
    let thumb = img.thumbnail(32, 32).to_rgba8();
    blurhash::encode(4, 3, thumb.width(), thumb.height(), thumb.as_raw())
        .map_err(|e| ArtworkError::Blurhash(e.to_string()))
}

/// Blurhash and oriented size of a decoded original.
pub fn describe(
    img: &DynamicImage,
    orientation: Orientation,
) -> Result<(String, u32, u32), ArtworkError> {
    let (w, h) = oriented_dims(img, orientation);
    let mut thumb = img.thumbnail(32, 32);
    thumb.apply_orientation(orientation);
    Ok((blurhash(&thumb)?, w, h))
}

/// At most [`POOL_PERMITS`] blocking jobs at once, and decodes within
/// [`MEMORY_BUDGET_MIB`].
#[derive(Clone)]
pub struct Pool {
    permits: Arc<Semaphore>,
    memory: Arc<Semaphore>,
    /// Jobs inside the pool right now, the peak and the total, for tests.
    #[cfg(test)]
    pub(crate) probe: Arc<Probe>,
}

#[cfg(test)]
#[derive(Default)]
pub(crate) struct Probe {
    inside: AtomicU64,
    /// Calls that have asked for a permit, waiting or not.
    pub(crate) queued: AtomicU64,
    pub(crate) peak: AtomicU64,
    pub(crate) runs: AtomicU64,
}

impl Default for Pool {
    fn default() -> Self {
        Self {
            permits: Arc::new(Semaphore::new(POOL_PERMITS)),
            memory: Arc::new(Semaphore::new(MEMORY_BUDGET_MIB as usize)),
            #[cfg(test)]
            probe: Arc::default(),
        }
    }
}

impl Pool {
    /// Run `f` on the blocking pool once a permit is free. The permit moves
    /// into the job, so a caller that gives up waiting cannot free the slot
    /// while the job is still running.
    pub async fn run<T, F>(&self, f: F) -> Result<T, ArtworkError>
    where
        F: FnOnce() -> T + Send + 'static,
        T: Send + 'static,
    {
        #[cfg(test)]
        self.probe.queued.fetch_add(1, Ordering::SeqCst);
        let permit = self
            .permits
            .clone()
            .acquire_owned()
            .await
            .map_err(|e| ArtworkError::Pool(e.to_string()))?;
        #[cfg(test)]
        let probe = self.probe.clone();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            #[cfg(test)]
            {
                let now = probe.inside.fetch_add(1, Ordering::SeqCst) + 1;
                probe.peak.fetch_max(now, Ordering::SeqCst);
                probe.runs.fetch_add(1, Ordering::SeqCst);
            }
            let out = f();
            #[cfg(test)]
            probe.inside.fetch_sub(1, Ordering::SeqCst);
            out
        })
        .await
        .map_err(|e| ArtworkError::Pool(e.to_string()))
    }

    /// Decode `path` inside the pool and run `f` on the image and its EXIF
    /// orientation. The source is opened only once a CPU permit is held, and
    /// decoded only once its [`open`] price fits in the memory budget, so
    /// queued requests hold no image bytes.
    pub async fn run_decoded<T, F>(&self, path: PathBuf, f: F) -> Result<T, ArtworkError>
    where
        F: FnOnce(DynamicImage, Orientation) -> Result<T, ArtworkError> + Send + 'static,
        T: Send + 'static,
    {
        let (memory, rt) = (self.memory.clone(), tokio::runtime::Handle::current());
        self.run(move || {
            let (decoder, cost) = open(&path)?;
            // Blocking here holds a CPU permit: under memory pressure decodes
            // run one at a time, which is the point.
            let _memory = rt
                .block_on(memory.acquire_many(cost))
                .map_err(|e| ArtworkError::Pool(e.to_string()))?;
            let (img, orientation) = decode(decoder)?;
            f(img, orientation)
        })
        .await
        .and_then(|r| r)
    }
}

/// Image store rooted at `<data>/images`. Resized variants live under
/// `cache/` and fetched originals under `orig/`; both are capped together at
/// `cap_bytes` with LRU-by-mtime eviction (both can be rebuilt). Methods do
/// blocking filesystem I/O: call them from inside [`Pool::run`] or
/// `spawn_blocking`.
pub struct Store {
    root: PathBuf,
    cap_bytes: u64,
    /// Bytes under `cache/` and `orig/`. The mutex also serialises writes and
    /// eviction, so the count stays exact.
    used: Mutex<u64>,
    tmp_seq: AtomicU64,
    pub pool: Pool,
    pub origin: Origin,
}

/// The capped areas under the store root.
const AREAS: [&str; 2] = ["cache", "orig"];

impl Store {
    /// Open the store, seeding the byte counter with a walk of `cache/` and
    /// `orig/`. Leftover temp files from a crash are removed. Nothing is
    /// created until the first write, so a missing directory is an empty cache.
    pub fn open(root: PathBuf, cap_bytes: u64) -> Self {
        let mut used = 0;
        for (path, size, _) in walk_areas(&root) {
            if is_temp(&path) {
                let _ = std::fs::remove_file(&path);
            } else {
                used += size;
            }
        }
        Self {
            root,
            cap_bytes,
            used: Mutex::new(used),
            tmp_seq: AtomicU64::new(0),
            pool: Pool::default(),
            origin: Origin::default(),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn used_bytes(&self) -> u64 {
        *self.used.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The cache path for `key` (a relative path such as
    /// `tmdb/abc.jpg/342.webp`), or `None` when the key could escape `cache/`.
    pub fn cache_path(&self, key: &str) -> Option<PathBuf> {
        self.area_path("cache", key)
    }

    /// The path of a fetched original (`tmdb/<file>`) under `orig/`.
    pub fn orig_path(&self, key: &str) -> Option<PathBuf> {
        self.area_path("orig", key)
    }

    fn area_path(&self, area: &str, key: &str) -> Option<PathBuf> {
        let rel = Path::new(key);
        let safe = !key.is_empty() && rel.components().all(|c| matches!(c, Component::Normal(_)));
        safe.then(|| self.root.join(area).join(rel))
    }

    /// A cache hit: returns the path and touches its mtime so LRU keeps it.
    pub fn get(&self, key: &str) -> Option<PathBuf> {
        touch(self.cache_path(key)?)
    }

    /// A stored original, touched like a cache hit.
    pub fn get_orig(&self, key: &str) -> Option<PathBuf> {
        touch(self.orig_path(key)?)
    }

    /// Write `bytes` under `key` (temp file + rename), then evict the oldest
    /// entries if the store is over its cap.
    pub fn put(&self, key: &str, bytes: &[u8]) -> Result<PathBuf, ArtworkError> {
        self.write(self.cache_path(key), bytes)
    }

    /// Store a fetched original; it counts toward the cap like a variant.
    pub fn put_orig(&self, key: &str, bytes: &[u8]) -> Result<PathBuf, ArtworkError> {
        self.write(self.orig_path(key), bytes)
    }

    fn write(&self, path: Option<PathBuf>, bytes: &[u8]) -> Result<PathBuf, ArtworkError> {
        let path =
            path.ok_or_else(|| ArtworkError::Io(std::io::Error::other("unsafe cache key")))?;
        let dir = path.parent().expect("cache path has a parent");
        std::fs::create_dir_all(dir)?;
        let name = path.file_name().expect("cache path has a file name");
        let seq = self.tmp_seq.fetch_add(1, Ordering::Relaxed);
        let tmp = dir.join(format!(".{}.{seq}.tmp", name.to_string_lossy()));
        std::fs::write(&tmp, bytes)?;

        let mut used = self.used.lock().unwrap_or_else(|e| e.into_inner());
        let replaced = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        if let Err(e) = std::fs::rename(&tmp, &path) {
            let _ = std::fs::remove_file(&tmp);
            return Err(e.into());
        }
        *used = *used - replaced.min(*used) + bytes.len() as u64;
        if *used > self.cap_bytes {
            self.evict(&mut used, &path);
        }
        Ok(path)
    }

    /// Delete everything cached under `key`: one variant or a whole
    /// `{kind}/{id}` directory. The byte counter drops by what was removed.
    pub fn remove(&self, key: &str) {
        let Some(path) = self.cache_path(key) else {
            return;
        };
        let mut used = self.used.lock().unwrap_or_else(|e| e.into_inner());
        for (file, size, _) in walk_files(&path) {
            if std::fs::remove_file(&file).is_ok() && !is_temp(&file) {
                *used -= size.min(*used);
            }
        }
        let _ = std::fs::remove_dir_all(&path);
    }

    /// Delete oldest-mtime files until usage is back under 90% of the cap.
    /// `keep` (the file just written) is never evicted.
    // ponytail: full walk per eviction; the 10% low-water mark keeps it rare.
    // An in-memory index replaces it if the cache grows past ~100k files.
    fn evict(&self, used: &mut u64, keep: &Path) {
        let low_water = self.cap_bytes - self.cap_bytes / 10;
        let mut files: Vec<_> = walk_areas(&self.root)
            .into_iter()
            .filter(|(p, _, _)| p != keep && !is_temp(p))
            .collect();
        files.sort_by_key(|(_, _, mtime)| *mtime);
        for (path, size, _) in files {
            if *used <= low_water {
                break;
            }
            if std::fs::remove_file(&path).is_ok() {
                *used -= size.min(*used);
            }
        }
    }
}

fn touch(path: PathBuf) -> Option<PathBuf> {
    let file = std::fs::File::options().append(true).open(&path).ok()?;
    let _ = file.set_modified(SystemTime::now());
    Some(path)
}

fn walk_areas(root: &Path) -> Vec<(PathBuf, u64, SystemTime)> {
    AREAS
        .iter()
        .flat_map(|area| walk_files(&root.join(area)))
        .collect()
}

fn is_temp(path: &Path) -> bool {
    path.extension().is_some_and(|e| e == "tmp")
}

/// Every regular file under `dir` with its size and mtime.
fn walk_files(dir: &Path) -> Vec<(PathBuf, u64, SystemTime)> {
    walkdir::WalkDir::new(dir)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            Some((e.into_path(), meta.len(), mtime))
        })
        .collect()
}

/// Production TMDB image origin (`Config::tmdb_image_base`).
pub const TMDB_ORIGIN: &str = "https://image.tmdb.org/t/p/original";
/// Concurrent origin fetches, process-wide.
pub const FETCH_SLOTS: usize = 2;
/// Whole-request timeout, under the gateway's 15 s TTFB.
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);
/// Largest original accepted from the origin.
pub const MAX_ORIGINAL_BYTES: usize = 10 * 1024 * 1024;
/// How long an origin 404 is remembered before the file is tried again.
const NEGATIVE_TTL_DAYS: i64 = 7;
/// Rows per prefetch query.
const PREFETCH_BATCH: i64 = 500;

/// A TMDB image file name: `^[A-Za-z0-9]{1,64}\.(jpg|png)$`.
pub fn valid_tmdb_name(name: &str) -> bool {
    name.rsplit_once('.').is_some_and(|(stem, ext)| {
        (1..=64).contains(&stem.len())
            && stem.bytes().all(|b| b.is_ascii_alphanumeric())
            && matches!(ext, "jpg" | "png")
    })
}

#[derive(Debug, thiserror::Error)]
pub enum FetchError {
    /// The origin answered 404, now or inside the cooldown.
    #[error("not found at origin")]
    NotFound,
    /// Transient failure or a rejected answer (redirect, size, content type).
    #[error("origin: {0}")]
    Upstream(String),
    #[error(transparent)]
    Db(#[from] sqlx::Error),
    #[error(transparent)]
    Artwork(#[from] ArtworkError),
}

/// Origin fetch state: a client with redirects off, the fetch slots and the
/// per-file single-flight locks.
pub struct Origin {
    http: reqwest::Client,
    slots: Semaphore,
    inflight: Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>,
}

impl Default for Origin {
    fn default() -> Self {
        Self {
            http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(FETCH_TIMEOUT)
                .build()
                .expect("reqwest client (TLS init)"),
            slots: Semaphore::new(FETCH_SLOTS),
            inflight: Mutex::new(HashMap::new()),
        }
    }
}

impl Origin {
    /// The lock every request for `key` takes; dead entries are pruned here.
    fn lock_for(&self, key: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut map = self.inflight.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(lock) = map.get(key).and_then(Weak::upgrade) {
            return lock;
        }
        map.retain(|_, w| w.strong_count() > 0);
        let lock = Arc::new(tokio::sync::Mutex::new(()));
        map.insert(key.to_string(), Arc::downgrade(&lock));
        lock
    }
}

fn now_stamp() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// The path of the TMDB original `file` (a name [`valid_tmdb_name`]
/// accepts) under `orig/tmdb/`, fetched once from `base` if it is not stored.
/// Requests for one file queue on its lock, so concurrent misses make one
/// origin hit. The bytes are not returned: callers decode through
/// [`Pool::run_decoded`], so they never sit in memory waiting for the pool.
// ponytail: the cap could evict the original between this call and the
// caller's decode (the file was just touched, so only a cache churning its
// whole cap in that window does); that request fails and the next refetches.
pub async fn tmdb_original(
    db: &crate::db::Db,
    store: &Arc<Store>,
    base: &str,
    file: &str,
) -> Result<PathBuf, FetchError> {
    let key = format!("tmdb/{file}");
    let lock = store.origin.lock_for(&key);
    let _guard = lock.lock().await;

    let stored = {
        let (store, key) = (store.clone(), key.clone());
        tokio::task::spawn_blocking(move || store.get_orig(&key))
            .await
            .map_err(|e| ArtworkError::Pool(e.to_string()))?
    };
    if let Some(path) = stored {
        return Ok(path);
    }
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(NEGATIVE_TTL_DAYS))
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let cooling: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM images WHERE key = ? AND failed_at > ?")
            .bind(&key)
            .bind(&cutoff)
            .fetch_optional(&db.pool)
            .await?;
    if cooling.is_some() {
        return Err(FetchError::NotFound);
    }

    // The slot is held until the body is on disk, so at most FETCH_SLOTS
    // fetched bodies are ever in memory.
    let fetched = {
        let _slot = store
            .origin
            .slots
            .acquire()
            .await
            .map_err(|e| ArtworkError::Pool(e.to_string()))?;
        match fetch(&store.origin.http, &format!("{base}/{file}")).await {
            Ok(bytes) => {
                let (st, k) = (store.clone(), key.clone());
                let stored = tokio::task::spawn_blocking(move || st.put_orig(&k, &bytes))
                    .await
                    .map_err(|e| ArtworkError::Pool(e.to_string()))??;
                Ok(stored)
            }
            Err(e) => Err(e),
        }
    };
    match fetched {
        Ok(path) => {
            // The placeholder is computed once, right after the fetch.
            let described = store
                .pool
                .run_decoded(path.clone(), |img, o| describe(&img, o))
                .await;
            if let Err(e) = &described {
                tracing::warn!(key, "tmdb image blurhash failed: {e}");
            }
            mark_fetched(db, &key, described.ok()).await?;
            Ok(path)
        }
        Err(FetchError::NotFound) => {
            mark_failed(db, &key).await?;
            Err(FetchError::NotFound)
        }
        Err(e) => {
            tracing::warn!(key, "tmdb image fetch failed: {e}");
            Err(e)
        }
    }
}

/// Record a fetched (or described) original with its placeholder, if any.
async fn mark_fetched(
    db: &crate::db::Db,
    key: &str,
    described: Option<(String, u32, u32)>,
) -> Result<(), sqlx::Error> {
    let (blurhash, width, height) = match described {
        Some((b, w, h)) => (Some(b), Some(w), Some(h)),
        None => (None, None, None),
    };
    sqlx::query(
        "INSERT INTO images (key, blurhash, width, height, fetched_at, attempts) \
         VALUES (?, ?, ?, ?, ?, 1) \
         ON CONFLICT(key) DO UPDATE SET blurhash = excluded.blurhash, \
         width = excluded.width, height = excluded.height, \
         fetched_at = excluded.fetched_at, failed_at = NULL, attempts = attempts + 1",
    )
    .bind(key)
    .bind(blurhash)
    .bind(width)
    .bind(height)
    .bind(now_stamp())
    .execute(&db.pool)
    .await?;
    Ok(())
}

/// Stamp a failure: an origin 404, or a local file that cannot be read or
/// decoded.
async fn mark_failed(db: &crate::db::Db, key: &str) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO images (key, failed_at, attempts) VALUES (?, ?, 1) \
         ON CONFLICT(key) DO UPDATE SET failed_at = excluded.failed_at, \
         attempts = attempts + 1",
    )
    .bind(key)
    .bind(now_stamp())
    .execute(&db.pool)
    .await?;
    Ok(())
}

/// Drop the `images` row and the cached variants of a local image
/// (`{kind}/{id}`) whose source changed or went away, so the next backfill
/// describes it afresh. The cache removal is a few unlinks, done inline.
pub async fn invalidate(db: &crate::db::Db, store: &Store, key: &str) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM images WHERE key = ?")
        .bind(key)
        .execute(&db.pool)
        .await?;
    store.remove(key);
    Ok(())
}

/// One GET: 404 is [`FetchError::NotFound`]; any other non-2xx (redirects
/// included, since the client follows none), a non-image content type or a
/// body over [`MAX_ORIGINAL_BYTES`] is [`FetchError::Upstream`].
async fn fetch(http: &reqwest::Client, url: &str) -> Result<Vec<u8>, FetchError> {
    let upstream = |e: reqwest::Error| FetchError::Upstream(e.without_url().to_string());
    let mut resp = http.get(url).send().await.map_err(upstream)?;
    let status = resp.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err(FetchError::NotFound);
    }
    if !status.is_success() {
        return Err(FetchError::Upstream(format!("status {status}")));
    }
    let ct = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !ct.starts_with("image/") {
        return Err(FetchError::Upstream(format!("content type {ct:?}")));
    }
    let too_large = || FetchError::Upstream("body over the size cap".into());
    if resp
        .content_length()
        .is_some_and(|n| n > MAX_ORIGINAL_BYTES as u64)
    {
        return Err(too_large());
    }
    let mut body = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(upstream)? {
        if body.len() + chunk.len() > MAX_ORIGINAL_BYTES {
            return Err(too_large());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// Fetch the poster of every movie and show that has no `images` row yet, in
/// batches of [`PREFETCH_BATCH`] through the shared fetch slots. Runs after
/// each scan; posters outside the library are fetched on first request.
/// Best-effort: failures are logged and the file is retried on a later pass
/// (a 404 only after its cooldown).
pub async fn prefetch_library(state: &crate::AppState) {
    let mut after = String::new();
    let (mut fetched, mut failed) = (0usize, 0usize);
    loop {
        let batch: Vec<String> = match sqlx::query_scalar(
            "SELECT p FROM (SELECT poster_path AS p FROM movies UNION SELECT poster_path FROM shows) \
             WHERE p > ? AND NOT EXISTS (SELECT 1 FROM images WHERE key = 'tmdb/' || ltrim(p, '/')) \
             ORDER BY p LIMIT ?",
        )
        .bind(&after)
        .bind(PREFETCH_BATCH)
        .fetch_all(&state.db.pool)
        .await
        {
            Ok(rows) => rows,
            Err(e) => {
                tracing::warn!("poster prefetch query failed: {e}");
                return;
            }
        };
        let Some(last) = batch.last() else { break };
        after = last.clone();
        let mut jobs = tokio::task::JoinSet::new();
        for path in &batch {
            let file = path.trim_start_matches('/').to_string();
            if !valid_tmdb_name(&file) {
                continue;
            }
            let (db, store) = (state.db.clone(), state.artwork.clone());
            let base = state.config.tmdb_image_base.clone();
            jobs.spawn(async move { tmdb_original(&db, &store, &base, &file).await });
        }
        while let Some(done) = jobs.join_next().await {
            match done {
                Ok(Ok(_)) => fetched += 1,
                _ => failed += 1,
            }
        }
        if (batch.len() as i64) < PREFETCH_BATCH {
            break;
        }
    }
    if fetched + failed > 0 {
        tracing::info!(fetched, failed, "library poster prefetch complete");
    }
}

/// Rows per backfill query.
const BACKFILL_BATCH: i64 = 200;

/// Describe (blurhash, width, height) every album cover, audiobook cover and
/// photo that has no `images` row yet, in batches of [`BACKFILL_BATCH`]
/// through the 2-permit pool. Runs after each scan, after the poster
/// prefetch (TMDB posters are described right after their fetch). A file
/// that cannot be read or decoded is stamped failed and left until a rescan
/// changes it ([`invalidate`]).
pub async fn backfill(state: &crate::AppState) {
    let (mut after_kind, mut after_id) = (String::new(), 0i64);
    let (mut described, mut failed) = (0usize, 0usize);
    loop {
        let batch: Vec<(String, i64, String)> = match sqlx::query_as(
            "SELECT kind, id, path FROM ( \
               SELECT 'album' AS kind, id, art_path AS path FROM albums WHERE art_path IS NOT NULL \
               UNION ALL SELECT 'audiobook', id, art_path FROM audiobooks WHERE art_path IS NOT NULL \
               UNION ALL SELECT 'photo', id, path FROM photos) \
             WHERE (kind, id) > (?, ?) \
             AND NOT EXISTS (SELECT 1 FROM images WHERE key = kind || '/' || id) \
             ORDER BY kind, id LIMIT ?",
        )
        .bind(&after_kind)
        .bind(after_id)
        .bind(BACKFILL_BATCH)
        .fetch_all(&state.db.pool)
        .await
        {
            Ok(rows) => rows,
            Err(e) => {
                tracing::warn!("blurhash backfill query failed: {e}");
                return;
            }
        };
        let Some((kind, id, _)) = batch.last() else {
            break;
        };
        (after_kind, after_id) = (kind.clone(), *id);
        let mut jobs = tokio::task::JoinSet::new();
        for (kind, id, path) in &batch {
            let (db, store) = (state.db.clone(), state.artwork.clone());
            let (key, path) = (format!("{kind}/{id}"), path.clone());
            jobs.spawn(async move {
                let result = store
                    .pool
                    .run_decoded(path.into(), |img, o| describe(&img, o))
                    .await;
                let ok = result.is_ok();
                let written = match result {
                    Ok(d) => mark_fetched(&db, &key, Some(d)).await,
                    Err(e) => {
                        tracing::debug!(key, "blurhash backfill failed: {e}");
                        mark_failed(&db, &key).await
                    }
                };
                if let Err(e) = written {
                    tracing::warn!(key, "blurhash backfill write failed: {e}");
                }
                ok
            });
        }
        while let Some(done) = jobs.join_next().await {
            match done {
                Ok(true) => described += 1,
                _ => failed += 1,
            }
        }
        if (batch.len() as i64) < BACKFILL_BATCH {
            break;
        }
    }
    if described + failed > 0 {
        tracing::info!(described, failed, "blurhash backfill complete");
    }
}

/// Fixture images built in-test, shared with the route tests.
#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;
    use image::{ImageFormat, Rgb, RgbImage};
    use std::io::Cursor;

    pub(crate) fn gradient(w: u32, h: u32) -> RgbImage {
        RgbImage::from_fn(w, h, |x, y| {
            Rgb([(x * 255 / w) as u8, (y * 255 / h) as u8, 90])
        })
    }

    pub(crate) fn encode(img: &DynamicImage, format: ImageFormat) -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        img.write_to(&mut out, format).unwrap();
        out.into_inner()
    }

    /// A JPEG with an APP1 EXIF segment carrying orientation 6 (rotate 90 CW).
    pub(crate) fn jpeg_with_orientation_6(w: u32, h: u32) -> Vec<u8> {
        let jpeg = encode(&DynamicImage::ImageRgb8(gradient(w, h)), ImageFormat::Jpeg);
        // Big-endian TIFF header with IFD0 at offset 8, one entry (Orientation
        // 0x0112, SHORT, count 1, value 6), then no next IFD.
        let tiff: &[u8] = b"MM\0\x2a\0\0\0\x08\0\x01\x01\x12\0\x03\0\0\0\x01\0\x06\0\0\0\0\0\0";
        let mut payload = b"Exif\0\0".to_vec();
        payload.extend_from_slice(tiff);
        let len = (payload.len() + 2) as u16;
        // SOI, then the APP1 segment, then the rest of the JPEG.
        let mut out = jpeg[..2].to_vec();
        out.extend_from_slice(&[0xFF, 0xE1]);
        out.extend_from_slice(&len.to_be_bytes());
        out.extend_from_slice(&payload);
        out.extend_from_slice(&jpeg[2..]);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::*;
    use super::*;
    use image::{ImageFormat, Rgba, RgbaImage};
    use std::time::Duration;

    fn webp_dims(bytes: &[u8]) -> (u32, u32) {
        let img = image::load_from_memory_with_format(bytes, ImageFormat::WebP).unwrap();
        (img.width(), img.height())
    }

    #[test]
    fn snap_width_rounds_up_to_the_ladder() {
        assert_eq!(snap_width(1), 92);
        assert_eq!(snap_width(92), 92);
        assert_eq!(snap_width(93), 185);
        assert_eq!(snap_width(300), 342);
        assert_eq!(snap_width(781), 1280);
        assert_eq!(snap_width(1920), 1920);
        assert_eq!(snap_width(5000), 1920);
    }

    #[test]
    fn variant_snaps_width_keeps_aspect_and_is_lossy_webp() {
        let img = DynamicImage::ImageRgb8(gradient(600, 900));
        let out = variant(&img, Orientation::NoTransforms, 300).unwrap();
        assert_eq!(&out[..4], b"RIFF");
        assert_eq!(&out[8..12], b"WEBP");
        assert_eq!(&out[12..16], b"VP8 ", "lossy bitstream, not VP8L");
        assert_eq!(webp_dims(&out), (342, 513));
    }

    #[test]
    fn variant_never_upscales() {
        let img = DynamicImage::ImageRgb8(gradient(120, 80));
        assert_eq!(
            webp_dims(&variant(&img, Orientation::NoTransforms, 1280).unwrap()),
            (120, 80)
        );
    }

    #[test]
    fn variant_keeps_alpha() {
        let img = DynamicImage::ImageRgba8(RgbaImage::from_pixel(200, 100, Rgba([10, 20, 30, 0])));
        let out = variant(&img, Orientation::NoTransforms, 92).unwrap();
        let back = image::load_from_memory_with_format(&out, ImageFormat::WebP).unwrap();
        assert!(back.color().has_alpha());
        assert_eq!((back.width(), back.height()), (92, 46));
    }

    /// [`open`] + [`decode`] of `bytes` written to a temp file.
    fn decode_bytes(bytes: &[u8]) -> Result<(DynamicImage, Orientation), ArtworkError> {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("src");
        std::fs::write(&path, bytes).unwrap();
        decode(open(&path)?.0)
    }

    #[test]
    fn decode_reads_png() {
        let png = encode(&DynamicImage::ImageRgb8(gradient(40, 20)), ImageFormat::Png);
        let (img, _) = decode_bytes(&png).unwrap();
        assert_eq!((img.width(), img.height()), (40, 20));
    }

    #[test]
    fn exif_orientation_6_is_applied_to_the_variant_and_the_description() {
        let (img, o) = decode_bytes(&jpeg_with_orientation_6(400, 200)).unwrap();
        assert_eq!(o, Orientation::Rotate90);
        assert_eq!((img.width(), img.height()), (400, 200), "stored, unrotated");
        assert_eq!(webp_dims(&variant(&img, o, 150).unwrap()), (185, 370));
        let (_, w, h) = describe(&img, o).unwrap();
        assert_eq!((w, h), (200, 400));
    }

    #[test]
    fn decode_rejects_garbage() {
        assert!(decode_bytes(b"not an image").is_err());
    }

    /// A 54-byte BMP header declaring a 20000x20000 24-bit image (1.2 GB of
    /// pixels) and carrying no pixel data.
    fn huge_bmp_header() -> Vec<u8> {
        let mut b = b"BM".to_vec();
        for v in [54u32 + 1_200_000_000, 0, 54, 40, 20_000, 20_000] {
            b.extend_from_slice(&v.to_le_bytes());
        }
        // Planes 1, 24 bits per pixel, then compression through important
        // colours all zero.
        b.extend_from_slice(&1u16.to_le_bytes());
        b.extend_from_slice(&24u16.to_le_bytes());
        b.extend_from_slice(&[0; 24]);
        b
    }

    #[test]
    fn a_decode_priced_over_the_memory_budget_is_refused_from_its_header() {
        let err =
            decode_bytes(&huge_bmp_header()).expect_err("refused before any pixel is allocated");
        assert!(
            matches!(err, ArtworkError::Decode(ImageError::Limits(_))),
            "{err}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn decodes_wait_for_the_memory_budget() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.png");
        std::fs::write(
            &path,
            encode(&DynamicImage::ImageRgb8(gradient(64, 64)), ImageFormat::Png),
        )
        .unwrap();
        let pool = Pool::default();
        let all = pool
            .memory
            .clone()
            .acquire_many_owned(MEMORY_BUDGET_MIB)
            .await
            .unwrap();
        let job = tokio::spawn({
            let pool = pool.clone();
            async move { pool.run_decoded(path, |img, _| Ok(img.width())).await }
        });
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(!job.is_finished(), "no decode while the budget is spent");
        drop(all);
        assert_eq!(job.await.unwrap().unwrap(), 64);
    }

    #[test]
    fn blurhash_is_deterministic_with_4x3_components() {
        let img = DynamicImage::ImageRgb8(gradient(300, 450));
        let a = blurhash(&img).unwrap();
        assert_eq!(a, blurhash(&img).unwrap());
        // Size flag (x-1) + (y-1)*9 = 21 is 'L' in base83; length is 4 + 2*x*y.
        assert!(a.starts_with('L'), "{a}");
        assert_eq!(a.len(), 28);
        assert_eq!(blurhash::decode(&a, 8, 6, 1.0).unwrap().len(), 8 * 6 * 4);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn pool_never_runs_more_than_two_jobs() {
        let pool = Pool::default();
        let jobs: Vec<_> = (0..8)
            .map(|_| {
                let pool = pool.clone();
                tokio::spawn(async move {
                    pool.run(|| std::thread::sleep(Duration::from_millis(30)))
                        .await
                        .unwrap()
                })
            })
            .collect();
        for job in jobs {
            job.await.unwrap();
        }
        assert_eq!(pool.probe.peak.load(Ordering::SeqCst), POOL_PERMITS as u64);
        assert_eq!(pool.probe.runs.load(Ordering::SeqCst), 8);
    }

    fn age(path: &Path, secs_ago: u64) {
        let file = std::fs::File::options().append(true).open(path).unwrap();
        file.set_modified(SystemTime::now() - Duration::from_secs(secs_ago))
            .unwrap();
    }

    fn disk_bytes(store: &Store) -> u64 {
        walk_files(&store.root().join("cache"))
            .iter()
            .map(|(_, s, _)| s)
            .sum()
    }

    #[test]
    fn cache_evicts_oldest_first_and_keeps_an_exact_count() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("images"), 1000);
        let a = store.put("x/a.webp", &[0; 300]).unwrap();
        let b = store.put("x/b.webp", &[0; 300]).unwrap();
        let c = store.put("y/c.webp", &[0; 300]).unwrap();
        age(&a, 300);
        age(&b, 200);
        age(&c, 100);
        assert_eq!(store.used_bytes(), 900);

        // A hit on `a` makes it the newest, so `b` is now the oldest.
        assert_eq!(store.get("x/a.webp"), Some(a.clone()));
        let d = store.put("x/d.webp", &[0; 300]).unwrap();
        assert!(!b.exists(), "oldest entry evicted first");
        assert!(a.exists() && c.exists() && d.exists());
        assert_eq!(store.used_bytes(), 900);
        assert_eq!(store.used_bytes(), disk_bytes(&store));

        // Replacing a file swaps its size instead of double counting.
        store.put("x/d.webp", &[0; 100]).unwrap();
        assert_eq!(store.used_bytes(), 700);
        assert_eq!(store.used_bytes(), disk_bytes(&store));

        // A reopen seeds the counter from disk and clears crash leftovers.
        std::fs::write(a.with_file_name(".a.webp.9.tmp"), [0; 50]).unwrap();
        let reopened = Store::open(dir.path().join("images"), 1000);
        assert_eq!(reopened.used_bytes(), 700);
        assert!(!a.with_file_name(".a.webp.9.tmp").exists());
    }

    #[test]
    fn cache_rejects_escaping_keys_and_misses_cleanly() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("images"), 1000);
        assert!(store.cache_path("../etc/passwd").is_none());
        assert!(store.cache_path("/abs").is_none());
        assert!(store.cache_path("").is_none());
        assert!(store.put("a/../../x", b"x").is_err());
        assert!(store.get("missing.webp").is_none());
        assert_eq!(store.used_bytes(), 0);
    }
}
