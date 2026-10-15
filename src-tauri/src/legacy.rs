//! Carrying an install over from when the app was called Stash.
//!
//! The rename changed the bundle identifier (`dev.stash.app` became
//! `io.github.vishnuvnathan.cliptack`), and Tauri derives the data and config
//! directories from it. Without this step an upgrade would open on an empty
//! history, and the credentials -- which exist nowhere else -- would look lost.
//!
//! The old directory is copied, never moved or deleted: it stays behind as the
//! fallback if anything here goes wrong. The database is copied with
//! `VACUUM INTO` rather than as files, because the old app may still be running
//! and most of a live database sits in its WAL -- copying the three files one
//! after another is not a snapshot. Passwords need nothing: DPAPI seals them to
//! the Windows account, not to a path.

use anyhow::{Context, Result};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{ConnectOptions, Connection};
use std::path::{Path, PathBuf};

/// The directory name the old identifier produced, beside the current one.
const LEGACY_DIR: &str = "dev.stash.app";
const LEGACY_DB: &str = "stash.db";

/// Copies a Stash install's data and settings into the Cliptack directories.
/// Runs at most once: the new database existing is the marker, and it is the
/// last thing written, so an interrupted carry-over simply runs again.
///
/// Returns whether anything was carried over.
pub async fn carry_over(data_dir: &Path, config_dir: &Path) -> Result<bool> {
    let new_db = data_dir.join(crate::db::DB_FILE);
    if new_db.exists() {
        return Ok(false);
    }
    let Some(old_data) = beside(data_dir) else {
        return Ok(false);
    };
    let old_db = old_data.join(LEGACY_DB);
    if !old_db.exists() {
        return Ok(false);
    }

    std::fs::create_dir_all(data_dir)
        .with_context(|| format!("creating {}", data_dir.display()))?;

    // Blob paths in the database are relative to `blobs/`, so the tree only
    // has to arrive in the same shape.
    copy_missing(&old_data.join("blobs"), &data_dir.join("blobs")).context("copying images")?;

    if let Some(old_config) = beside(config_dir) {
        let (from, to) = (crate::settings::path(&old_config), crate::settings::path(config_dir));
        if from.exists() && !to.exists() {
            std::fs::create_dir_all(config_dir)?;
            std::fs::copy(&from, &to).context("copying settings")?;
        }
    }

    snapshot(&old_db, &new_db).await.context("copying the database")?;
    Ok(true)
}

/// The legacy directory next to `dir`, unless `dir` already is it.
fn beside(dir: &Path) -> Option<PathBuf> {
    let old = dir.parent()?.join(LEGACY_DIR);
    (old != dir).then_some(old)
}

/// A transactionally consistent copy of `from`, written to a temporary name and
/// renamed into place, so `to` never exists half-written.
async fn snapshot(from: &Path, to: &Path) -> Result<()> {
    let tmp = to.with_extension("db.carrying");
    let _ = std::fs::remove_file(&tmp);

    let mut conn = SqliteConnectOptions::new()
        .filename(from)
        .create_if_missing(false)
        .busy_timeout(std::time::Duration::from_secs(5))
        .connect()
        .await?;
    // VACUUM INTO takes a string literal, not a bound parameter.
    let target = tmp.to_str().context("app data path is not UTF-8")?.replace('\'', "''");
    sqlx::query(&format!("VACUUM INTO '{target}'"))
        .execute(&mut conn)
        .await?;
    conn.close().await?;

    std::fs::rename(&tmp, to)?;
    Ok(())
}

/// Copies every file under `from` that `to` does not already have.
fn copy_missing(from: &Path, to: &Path) -> std::io::Result<()> {
    if !from.is_dir() {
        return Ok(());
    }
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let dest = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_missing(&entry.path(), &dest)?;
        } else if !dest.exists() {
            std::fs::copy(entry.path(), &dest)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{self, queries};

    fn roaming() -> PathBuf {
        std::env::temp_dir().join(format!("cliptack-test-{}", uuid::Uuid::new_v4()))
    }

    /// The real case: Stash still running, its last writes still in the WAL,
    /// an image on disk and a settings file beside the database.
    #[tokio::test]
    async fn carries_a_running_stash_install_over() {
        let root = roaming();
        let old = root.join(LEGACY_DIR);
        let new = root.join("io.github.vishnuvnathan.cliptack");

        let stash = db::open(&old, LEGACY_DB).await.unwrap();
        queries::insert_note(&stash.pool, "Carried".into(), "zebra crossing".into())
            .await
            .unwrap();
        std::fs::create_dir_all(old.join("blobs/ab")).unwrap();
        std::fs::write(old.join("blobs/ab/abcd.png"), b"png bytes").unwrap();
        std::fs::write(old.join("settings.json"), br#"{"theme":"light"}"#).unwrap();

        assert!(carry_over(&new, &new).await.unwrap());

        let cliptack = db::init(&new).await.unwrap();
        let hits = queries::search(&cliptack.pool, "zebra", &Default::default(), 10, 0)
            .await
            .unwrap();
        assert_eq!(hits.len(), 1, "the note did not survive, or FTS did not");
        assert_eq!(std::fs::read(new.join("blobs/ab/abcd.png")).unwrap(), b"png bytes");
        assert!(std::fs::read_to_string(new.join("settings.json")).unwrap().contains("light"));

        // The original is untouched and still open.
        assert!(old.join(LEGACY_DB).exists());
        drop(stash);
    }

    /// Once Cliptack has its own database, a leftover Stash directory must never
    /// overwrite it -- that would roll the user's history back.
    #[tokio::test]
    async fn never_runs_twice() {
        let root = roaming();
        let old = root.join(LEGACY_DIR);
        let new = root.join("io.github.vishnuvnathan.cliptack");

        db::open(&old, LEGACY_DB).await.unwrap().pool.close().await;
        assert!(carry_over(&new, &new).await.unwrap());

        let cliptack = db::init(&new).await.unwrap();
        queries::insert_note(&cliptack.pool, "Newer".into(), "written after".into())
            .await
            .unwrap();
        cliptack.pool.close().await;

        assert!(!carry_over(&new, &new).await.unwrap());
        let cliptack = db::init(&new).await.unwrap();
        let hits = queries::search(&cliptack.pool, "written", &Default::default(), 10, 0)
            .await
            .unwrap();
        assert_eq!(hits.len(), 1);
    }

    #[tokio::test]
    async fn a_fresh_install_has_nothing_to_carry() {
        let new = roaming().join("io.github.vishnuvnathan.cliptack");
        assert!(!carry_over(&new, &new).await.unwrap());
        assert!(!new.exists(), "created a directory for nothing");
    }
}
