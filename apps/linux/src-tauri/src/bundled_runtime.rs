//! Materialize only app-owned program resources; the CLI still owns Gateway services.
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(serde::Deserialize)]
struct RuntimeManifest {
    version: String,
    sha256: String,
}

#[cfg(target_os = "linux")]
pub(crate) fn prepare(source: &Path, base: &Path, app_version: &str) -> Result<PathBuf, String> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(base)
        .map_err(|e| e.to_string())?;
    let metadata = fs::symlink_metadata(base).map_err(|e| e.to_string())?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o022 != 0
    {
        return Err("Bundled runtime directory is redirected.".into());
    }
    let bytes = fs::read(source).map_err(|e| e.to_string())?;
    let hash: String = Sha256::digest(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let manifest: RuntimeManifest = serde_json::from_slice(
        &fs::read(source.with_file_name("manifest.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    if manifest.sha256 != hash {
        return Err("Included runtime digest does not match its manifest.".into());
    }
    if app_version != "0.1.0" && manifest.version != app_version {
        return Err("Included runtime does not match the desktop release.".into());
    }
    let name = format!("sea-{hash}");
    let version = base.join(&name);
    let temporary = base.join(format!(".stage-{}", uuid::Uuid::new_v4()));
    // A stable service command must never point into an ephemeral AppImage mount.
    // Retain earlier content-addressed resources for an app rollback and live workers.
    let result = (|| {
        match fs::symlink_metadata(&version) {
            Ok(info) => {
                if !info.is_file()
                    || info.file_type().is_symlink()
                    || fs::read(&version).map_err(|e| e.to_string())? != bytes
                {
                    return Err("Bundled runtime resource changed.".into());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::write(&temporary, &bytes).map_err(|e| e.to_string())?;
                fs::set_permissions(&temporary, fs::Permissions::from_mode(0o500))
                    .map_err(|e| e.to_string())?;
                fs::rename(&temporary, &version).map_err(|e| e.to_string())?;
            }
            Err(error) => return Err(error.to_string()),
        }
        Ok(version)
    })();
    let _ = fs::remove_file(&temporary);
    result
}

/// The caller's existing process owner must successfully probe the candidate
/// before this publishes it. Copying a SEA alone never changes a service target.
pub(crate) fn activate(candidate: &Path, base: &Path) -> Result<(), String> {
    use std::os::unix::fs::{symlink, MetadataExt};
    let metadata = fs::symlink_metadata(base).map_err(|e| e.to_string())?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o022 != 0
    {
        return Err("Bundled runtime directory is redirected.".into());
    }
    let name = candidate
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("Invalid runtime candidate")?;
    if candidate.parent() != Some(base)
        || !name.starts_with("sea-")
        || name.len() != 68
        || !name[4..].bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("Runtime candidate is outside its app-owned directory.".into());
    }
    let stable = base.join("openclaw-runtime");
    let temporary = base.join(format!(".activate-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        match fs::symlink_metadata(&stable) {
            Ok(info) => {
                if !info.file_type().is_symlink() {
                    return Err("App runtime launcher is not an app-owned link.".into());
                }
                let target = fs::read_link(&stable).map_err(|e| e.to_string())?;
                let target = target.to_string_lossy();
                if !target.starts_with("sea-")
                    || target.len() != 68
                    || !target[4..].bytes().all(|c| c.is_ascii_hexdigit())
                {
                    return Err(
                        "App runtime launcher points outside its resource directory.".into(),
                    );
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
        symlink(name, &temporary).map_err(|e| e.to_string())?;
        fs::rename(&temporary, &stable).map_err(|e| e.to_string())?;

        Ok(())
    })();
    let _ = fs::remove_file(&temporary);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn manifest(source: &Path) {
        let sha256: String = Sha256::digest(fs::read(source).unwrap())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        fs::write(
            source.with_file_name("manifest.json"),
            serde_json::json!({"version":"2026.9.5", "sha256":sha256}).to_string(),
        )
        .unwrap();
    }

    #[test]
    fn stable_launcher_survives_relocation_and_failed_update() {
        let root = std::env::temp_dir().join(format!("openclaw-runtime-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let source = root.join("resource");
        let base = root.join("runtime");
        let first = b"#!/bin/sh\nprintf first\n";
        fs::write(&source, first).unwrap();
        manifest(&source);
        let candidate = prepare(&source, &base, "0.1.0").unwrap();
        let stable = base.join("openclaw-runtime");
        assert!(
            !stable.exists(),
            "staging must not publish a service target"
        );
        assert!(Command::new(&candidate)
            .arg("--version")
            .status()
            .unwrap()
            .success());
        activate(&candidate, &base).unwrap();
        let previous = fs::read_link(&stable).unwrap();
        fs::write(&source, b"#!/bin/sh\nexit 1\n").unwrap();
        assert!(prepare(&source, &base, "0.1.0").is_err());
        assert_eq!(fs::read_link(&stable).unwrap(), previous);
        fs::write(&source, b"#!/bin/sh\nprintf second\n").unwrap();
        manifest(&source);
        assert!(prepare(&source, &base, "2026.9.6").is_err());
        assert_eq!(fs::read_link(&stable).unwrap(), previous);
        let candidate = prepare(&source, &base, "0.1.0").unwrap();
        assert_eq!(fs::read_link(&stable).unwrap(), previous);
        activate(&candidate, &base).unwrap();
        assert_ne!(fs::read_link(&stable).unwrap(), previous);
        fs::write(&source, first).unwrap();
        manifest(&source);
        let candidate = prepare(&source, &base, "0.1.0").unwrap();
        activate(&candidate, &base).unwrap();
        assert_eq!(fs::read_link(&stable).unwrap(), previous);
        fs::remove_file(&source).unwrap();
        assert_eq!(Command::new(&stable).output().unwrap().stdout, b"first");
        fs::remove_dir_all(root).unwrap();
    }
}
