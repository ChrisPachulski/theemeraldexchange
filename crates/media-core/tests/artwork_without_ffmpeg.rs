//! Scan-time cover art never spawns ffmpeg. The music and audiobook passes
//! run with PATH holding only a stub `ffprobe` and a stub `ffmpeg` that
//! leaves a marker when called; the covers must land and the marker must not.
//! One test in its own binary, because it swaps the process PATH.
#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use lofty::picture::{MimeType, Picture, PictureType};
use lofty::prelude::*;
use media_core::artwork::Store;
use media_core::db::Db;
use media_core::scanner;

fn script(path: &Path, body: &str) {
    std::fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

fn tagged_copy(ext: &str, dest: &Path, picture: &[u8]) {
    let src =
        Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("tests/fixtures/audio/tiny.{ext}"));
    std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
    std::fs::copy(src, dest).unwrap();
    let file = lofty::read_from_path(dest).unwrap();
    let mut tag = lofty::tag::Tag::new(file.primary_tag_type());
    tag.push_picture(
        Picture::unchecked(picture.to_vec())
            .pic_type(PictureType::CoverFront)
            .mime_type(MimeType::Jpeg)
            .build(),
    );
    tag.save_to_path(dest, lofty::config::WriteOptions::default())
        .unwrap();
}

#[tokio::test]
async fn scans_extract_cover_art_without_ffmpeg() {
    let bin = tempfile::tempdir().unwrap();
    let marker = bin.path().join("ffmpeg-called");
    script(
        &bin.path().join("ffprobe"),
        r#"echo '{"streams":[{"codec_type":"audio","codec_name":"mp3"}],"format":{"duration":"1.0","tags":{"artist":"A","album":"B"}}}'"#,
    );
    script(
        &bin.path().join("ffmpeg"),
        &format!(": > '{}'\nexit 1", marker.display()),
    );
    // SAFETY: the only test in this binary, run before any thread reads PATH.
    unsafe { std::env::set_var("PATH", bin.path()) };

    let lib = tempfile::tempdir().unwrap();
    let art_dir = tempfile::tempdir().unwrap();
    let images_dir = tempfile::tempdir().unwrap();
    let images = Store::open(images_dir.path().to_path_buf(), u64::MAX);
    let picture = b"\xFF\xD8\xFF\xE0 not decoded, only copied";
    tagged_copy("mp3", &lib.path().join("music/01.mp3"), picture);
    tagged_copy("m4a", &lib.path().join("books/Dune.m4b"), picture);
    let db = Db::connect_memory().await.unwrap();

    let music = scanner::scan_music_once(&db, &[lib.path().join("music")], art_dir.path(), &images)
        .await
        .unwrap();
    let books =
        scanner::scan_audiobooks_once(&db, &[lib.path().join("books")], art_dir.path(), &images)
            .await
            .unwrap();
    assert_eq!((music.files_added, books.files_added), (1, 1));

    let arts: Vec<String> =
        sqlx::query_scalar("SELECT art_path FROM albums UNION ALL SELECT art_path FROM audiobooks")
            .fetch_all(&db.pool)
            .await
            .unwrap();
    assert_eq!(arts.len(), 2);
    for art in arts {
        assert_eq!(std::fs::read(&art).unwrap(), picture, "{art}");
    }
    assert!(!marker.exists(), "ffmpeg was spawned");
}
