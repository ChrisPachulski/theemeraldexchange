//! Artwork core: decode (EXIF orientation applied), resize to a fixed width
//! ladder, encode lossy WebP, compute blurhash placeholders, and keep the
//! resized variants in a disk-capped LRU cache under `<data>/images/cache`.
//!
//! CPU work runs through [`Pool`], a constant 2-permit gate around
//! `spawn_blocking`, so image decoding never takes more than two of the NAS's
//! six threads away from Plex.

use std::io::Cursor;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use fast_image_resize::images::{Image, ImageRef};
use fast_image_resize::{PixelType, Resizer};
use image::{DynamicImage, ImageDecoder, ImageReader};
use tokio::sync::Semaphore;

/// Served widths. A request snaps up to the next rung so the cache holds at
/// most seven variants per image, whatever widths clients ask for.
pub const WIDTHS: [u32; 7] = [92, 185, 342, 500, 780, 1280, 1920];
/// Concurrent CPU jobs. Constant on purpose: Plex keeps the other cores.
pub const POOL_PERMITS: usize = 2;
/// Lossy WebP quality.
pub const WEBP_QUALITY: f32 = 80.0;

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

/// Decode any supported format, rotating/flipping per the EXIF orientation so
/// a portrait phone photo comes out portrait.
pub fn decode(bytes: &[u8]) -> Result<DynamicImage, ArtworkError> {
    let mut decoder = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()?
        .into_decoder()?;
    let orientation = decoder.orientation()?;
    let mut img = DynamicImage::from_decoder(decoder)?;
    img.apply_orientation(orientation);
    Ok(img)
}

/// The smallest ladder width at or above `w` (the largest rung beyond it).
pub fn snap_width(w: u32) -> u32 {
    WIDTHS
        .iter()
        .copied()
        .find(|&rung| rung >= w)
        .unwrap_or(WIDTHS[WIDTHS.len() - 1])
}

/// Resize to the snapped width (never upscaling) and encode lossy WebP.
pub fn variant(img: &DynamicImage, w: u32) -> Result<Vec<u8>, ArtworkError> {
    let (src_w, src_h) = (img.width(), img.height());
    if src_w == 0 || src_h == 0 {
        return Err(ArtworkError::Resize("empty image".into()));
    }
    let dst_w = snap_width(w).min(src_w);
    let dst_h = ((u64::from(src_h) * u64::from(dst_w) + u64::from(src_w) / 2) / u64::from(src_w))
        .max(1) as u32;

    let alpha = img.color().has_alpha();
    let (pixels, pixel_type) = if alpha {
        (img.to_rgba8().into_raw(), PixelType::U8x4)
    } else {
        (img.to_rgb8().into_raw(), PixelType::U8x3)
    };
    let src = ImageRef::new(src_w, src_h, &pixels, pixel_type)
        .map_err(|e| ArtworkError::Resize(e.to_string()))?;
    let mut dst = Image::new(dst_w, dst_h, pixel_type);
    Resizer::new()
        .resize(&src, &mut dst, None)
        .map_err(|e| ArtworkError::Resize(e.to_string()))?;

    let encoder = if alpha {
        webp::Encoder::from_rgba(dst.buffer(), dst_w, dst_h)
    } else {
        webp::Encoder::from_rgb(dst.buffer(), dst_w, dst_h)
    };
    let webp = encoder
        .encode_simple(false, WEBP_QUALITY)
        .map_err(|e| ArtworkError::Encode(format!("{e:?}")))?;
    Ok(webp.to_vec())
}

/// A 4x3-component blurhash of the image, computed on a 32px thumbnail.
pub fn blurhash(img: &DynamicImage) -> Result<String, ArtworkError> {
    let thumb = img.thumbnail(32, 32).to_rgba8();
    blurhash::encode(4, 3, thumb.width(), thumb.height(), thumb.as_raw())
        .map_err(|e| ArtworkError::Blurhash(e.to_string()))
}

/// At most [`POOL_PERMITS`] blocking jobs at once.
#[derive(Clone)]
pub struct Pool(Arc<Semaphore>);

impl Default for Pool {
    fn default() -> Self {
        Self(Arc::new(Semaphore::new(POOL_PERMITS)))
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
        let permit = self
            .0
            .clone()
            .acquire_owned()
            .await
            .map_err(|e| ArtworkError::Pool(e.to_string()))?;
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            f()
        })
        .await
        .map_err(|e| ArtworkError::Pool(e.to_string()))
    }
}

/// Image store rooted at `<data>/images`. Resized variants live under
/// `cache/`, capped at `cap_bytes` with LRU-by-mtime eviction. Methods do
/// blocking filesystem I/O: call them from inside [`Pool::run`] or
/// `spawn_blocking`.
pub struct Store {
    root: PathBuf,
    cap_bytes: u64,
    /// Bytes under `cache/`. The mutex also serialises writes and eviction,
    /// so the count stays exact.
    used: Mutex<u64>,
    tmp_seq: AtomicU64,
    pub pool: Pool,
}

impl Store {
    /// Open the store, seeding the byte counter with a walk of `cache/`.
    /// Leftover temp files from a crash are removed. Nothing is created until
    /// the first write, so a missing directory is an empty cache.
    pub fn open(root: PathBuf, cap_bytes: u64) -> Self {
        let mut used = 0;
        for (path, size, _) in walk_files(&root.join("cache")) {
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
        let rel = Path::new(key);
        let safe = !key.is_empty() && rel.components().all(|c| matches!(c, Component::Normal(_)));
        safe.then(|| self.root.join("cache").join(rel))
    }

    /// A cache hit: returns the path and touches its mtime so LRU keeps it.
    pub fn get(&self, key: &str) -> Option<PathBuf> {
        let path = self.cache_path(key)?;
        let file = std::fs::File::options().append(true).open(&path).ok()?;
        let _ = file.set_modified(SystemTime::now());
        Some(path)
    }

    /// Write `bytes` under `key` (temp file + rename), then evict the oldest
    /// entries if the cache is over its cap.
    pub fn put(&self, key: &str, bytes: &[u8]) -> Result<PathBuf, ArtworkError> {
        let path = self
            .cache_path(key)
            .ok_or_else(|| ArtworkError::Io(std::io::Error::other("unsafe cache key")))?;
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
        let mut files: Vec<_> = walk_files(&self.root.join("cache"))
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

/// Fixture images built in-test, shared with the route tests.
#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;
    use image::{ImageFormat, Rgb, RgbImage};

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
    use std::sync::atomic::AtomicUsize;
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
        let out = variant(&img, 300).unwrap();
        assert_eq!(&out[..4], b"RIFF");
        assert_eq!(&out[8..12], b"WEBP");
        assert_eq!(&out[12..16], b"VP8 ", "lossy bitstream, not VP8L");
        assert_eq!(webp_dims(&out), (342, 513));
    }

    #[test]
    fn variant_never_upscales() {
        let img = DynamicImage::ImageRgb8(gradient(120, 80));
        assert_eq!(webp_dims(&variant(&img, 1280).unwrap()), (120, 80));
    }

    #[test]
    fn variant_keeps_alpha() {
        let img = DynamicImage::ImageRgba8(RgbaImage::from_pixel(200, 100, Rgba([10, 20, 30, 0])));
        let out = variant(&img, 92).unwrap();
        let back = image::load_from_memory_with_format(&out, ImageFormat::WebP).unwrap();
        assert!(back.color().has_alpha());
        assert_eq!((back.width(), back.height()), (92, 46));
    }

    #[test]
    fn decode_reads_png() {
        let png = encode(&DynamicImage::ImageRgb8(gradient(40, 20)), ImageFormat::Png);
        let img = decode(&png).unwrap();
        assert_eq!((img.width(), img.height()), (40, 20));
    }

    #[test]
    fn decode_applies_exif_orientation_6() {
        let img = decode(&jpeg_with_orientation_6(64, 32)).unwrap();
        assert_eq!((img.width(), img.height()), (32, 64));
    }

    #[test]
    fn decode_rejects_garbage() {
        assert!(decode(b"not an image").is_err());
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
        let inside = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let jobs: Vec<_> = (0..8)
            .map(|_| {
                let (pool, inside, peak) = (pool.clone(), inside.clone(), peak.clone());
                tokio::spawn(async move {
                    pool.run(move || {
                        let now = inside.fetch_add(1, Ordering::SeqCst) + 1;
                        peak.fetch_max(now, Ordering::SeqCst);
                        std::thread::sleep(Duration::from_millis(30));
                        inside.fetch_sub(1, Ordering::SeqCst);
                    })
                    .await
                    .unwrap()
                })
            })
            .collect();
        for job in jobs {
            job.await.unwrap();
        }
        assert_eq!(peak.load(Ordering::SeqCst), POOL_PERMITS);
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
