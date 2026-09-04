//! Download same-version headless CLI archives from GitHub Releases.
//!
//! Asset naming matches `.github/workflows/release.yml` / `docs/test/release.md`:
//! `agentero-cli-{version}-{rust-host}.{tar.gz|zip}` plus sibling `.sha256`.

use crate::core::error::AppError;
use crate::core::http;
use flate2::read::GzDecoder;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io;
use std::path::Path;
use std::time::Duration;
use tar::Archive;

/// GitHub org/repo that publishes CLI archives (stable public CDN URLs).
pub const RELEASE_REPO: &str = "poco-ai/Agentero";

const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(180);

/// Rust target triple for the running desktop binary (must match CI `rustc -vV host`).
pub fn host_triple() -> Option<&'static str> {
    // Keep in sync with release CLI matrix runners.
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        return Some("aarch64-apple-darwin");
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        // Not currently built by CI (macos-latest is arm64). Still form a URL so
        // callers can surface a clear 404 / unsupported message.
        return Some("x86_64-apple-darwin");
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        return Some("x86_64-unknown-linux-gnu");
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        return Some("aarch64-unknown-linux-gnu");
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        return Some("x86_64-pc-windows-msvc");
    }
    #[allow(unreachable_code)]
    None
}

/// Strip a leading `v` so tag `v0.5.3` and cargo `0.5.3` compare equal.
pub fn normalize_version(raw: &str) -> &str {
    raw.trim().trim_start_matches('v')
}

pub fn versions_equal(a: &str, b: &str) -> bool {
    normalize_version(a) == normalize_version(b)
}

/// Archive file extension for this host (without leading dot).
pub fn archive_ext_for_triple(triple: &str) -> &'static str {
    if triple.contains("windows") {
        "zip"
    } else {
        "tar.gz"
    }
}

/// User-facing binary name inside the release archive.
pub fn archive_inner_name() -> &'static str {
    if cfg!(windows) {
        "agentero.exe"
    } else {
        "agentero"
    }
}

/// Managed on-disk name for the cached CLI binary.
pub fn managed_binary_name() -> &'static str {
    archive_inner_name()
}

pub fn archive_file_name(version: &str, triple: &str) -> String {
    let ver = normalize_version(version);
    let ext = archive_ext_for_triple(triple);
    format!("agentero-cli-{ver}-{triple}.{ext}")
}

pub fn release_download_url(version: &str, triple: &str) -> String {
    let ver = normalize_version(version);
    let asset = archive_file_name(ver, triple);
    format!("https://github.com/{RELEASE_REPO}/releases/download/v{ver}/{asset}")
}

pub fn release_sha256_url(version: &str, triple: &str) -> String {
    format!("{}.sha256", release_download_url(version, triple))
}

pub fn release_tag_page_url(version: &str) -> String {
    let ver = normalize_version(version);
    format!("https://github.com/{RELEASE_REPO}/releases/tag/v{ver}")
}

/// Parse `sha256sum` output: `<hex>  <filename>` or `<hex> *<filename>`.
pub fn parse_sha256_file(text: &str) -> Result<String, AppError> {
    let line = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .ok_or_else(|| AppError::message("empty sha256 file"))?;
    let hex = line
        .split_whitespace()
        .next()
        .ok_or_else(|| AppError::message(format!("invalid sha256 line: {line}")))?
        .to_ascii_lowercase();
    if hex.len() != 64 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(AppError::message(format!(
            "invalid sha256 digest (want 64 hex chars): {hex}"
        )));
    }
    Ok(hex)
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// Extract the CLI binary from a release archive into `dest_bin`.
pub fn extract_cli_binary(
    archive_bytes: &[u8],
    archive_name: &str,
    dest_bin: &Path,
) -> Result<(), AppError> {
    if let Some(parent) = dest_bin.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = dest_bin.with_extension("partial");
    let _ = fs::remove_file(&tmp);

    if archive_name.ends_with(".zip") {
        extract_zip_member(archive_bytes, archive_inner_name(), &tmp)?;
    } else if archive_name.ends_with(".tar.gz") || archive_name.ends_with(".tgz") {
        extract_tar_gz_member(archive_bytes, archive_inner_name(), &tmp)?;
    } else {
        return Err(AppError::message(format!(
            "unsupported CLI archive format: {archive_name}"
        )));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&tmp)?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&tmp, perms)?;
    }

    // Atomic-ish replace.
    let _ = fs::remove_file(dest_bin);
    fs::rename(&tmp, dest_bin).map_err(|e| {
        AppError::message(format!(
            "failed to place CLI binary at {}: {e}",
            dest_bin.display()
        ))
    })?;
    Ok(())
}

fn extract_tar_gz_member(bytes: &[u8], member_name: &str, dest: &Path) -> Result<(), AppError> {
    let dec = GzDecoder::new(bytes);
    let mut archive = Archive::new(dec);
    let mut found = false;
    for entry in archive
        .entries()
        .map_err(|e| AppError::message(format!("tar read error: {e}")))?
    {
        let mut entry = entry.map_err(|e| AppError::message(format!("tar entry error: {e}")))?;
        let path = entry
            .path()
            .map_err(|e| AppError::message(format!("tar path error: {e}")))?
            .to_path_buf();
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or_default();
        if name != member_name {
            continue;
        }
        let mut out = File::create(dest)?;
        io::copy(&mut entry, &mut out)
            .map_err(|e| AppError::message(format!("tar extract write error: {e}")))?;
        found = true;
        break;
    }
    if !found {
        return Err(AppError::message(format!(
            "archive missing `{member_name}` entry"
        )));
    }
    Ok(())
}

fn extract_zip_member(bytes: &[u8], member_name: &str, dest: &Path) -> Result<(), AppError> {
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|e| AppError::message(format!("zip open error: {e}")))?;
    // Prefer exact name; also accept path suffixes.
    let mut index = None;
    for i in 0..archive.len() {
        let file = archive
            .by_index(i)
            .map_err(|e| AppError::message(format!("zip entry error: {e}")))?;
        let name = file.name();
        let base = Path::new(name)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(name);
        if base == member_name || name == member_name {
            index = Some(i);
            break;
        }
    }
    let index = index
        .ok_or_else(|| AppError::message(format!("zip archive missing `{member_name}` entry")))?;
    let mut file = archive
        .by_index(index)
        .map_err(|e| AppError::message(format!("zip entry error: {e}")))?;
    let mut out = File::create(dest)?;
    io::copy(&mut file, &mut out)
        .map_err(|e| AppError::message(format!("zip extract write error: {e}")))?;
    Ok(())
}

/// Download archive + checksum for `version`, verify, extract into `dest_bin`.
pub async fn download_and_extract(version: &str, dest_bin: &Path) -> Result<(), AppError> {
    let triple = host_triple().ok_or_else(|| {
        AppError::message(
            "CLI download is not supported on this platform (no matching Release triple)",
        )
    })?;
    let ver = normalize_version(version).to_string();
    let archive_name = archive_file_name(&ver, triple);
    let archive_url = release_download_url(&ver, triple);
    let sha_url = release_sha256_url(&ver, triple);
    let tag_page = release_tag_page_url(&ver);

    let client = http::client_builder()
        .timeout(DOWNLOAD_TIMEOUT)
        .user_agent(format!(
            "agentero/{ver} (+https://github.com/{RELEASE_REPO})"
        ))
        .build()
        .map_err(|e| AppError::message(format!("http client error: {e}")))?;

    let sha_text = fetch_text(&client, &sha_url, &tag_page).await?;
    let expected = parse_sha256_file(&sha_text)?;

    let archive_bytes = fetch_bytes(&client, &archive_url, &tag_page).await?;
    let actual = sha256_hex(&archive_bytes);
    if actual != expected {
        return Err(AppError::message(format!(
            "CLI archive checksum mismatch (expected {expected}, got {actual})"
        )));
    }

    extract_cli_binary(&archive_bytes, &archive_name, dest_bin)?;
    Ok(())
}

async fn fetch_bytes(
    client: &reqwest::Client,
    url: &str,
    tag_page: &str,
) -> Result<Vec<u8>, AppError> {
    let res = client
        .get(url)
        .send()
        .await
        .map_err(|e| AppError::message(format!("download failed ({url}): {e}")))?;
    let status = res.status();
    if status.as_u16() == 404 {
        // Include the requested URL: its asset name carries the host triple,
        // so architecture/version mismatches are self-explanatory.
        return Err(AppError::message(format!(
            "CLI asset not found (404): {url}. Open {tag_page} to check the published release assets"
        )));
    }
    if !status.is_success() {
        return Err(AppError::message(format!(
            "download failed HTTP {status} for {url}"
        )));
    }
    res.bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| AppError::message(format!("download body error: {e}")))
}

async fn fetch_text(
    client: &reqwest::Client,
    url: &str,
    tag_page: &str,
) -> Result<String, AppError> {
    let bytes = fetch_bytes(client, url, tag_page).await?;
    String::from_utf8(bytes)
        .map_err(|e| AppError::message(format!("checksum file is not UTF-8: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;

    #[test]
    fn normalizes_version_prefix() {
        assert_eq!(normalize_version("v0.5.3"), "0.5.3");
        assert_eq!(normalize_version("0.5.3"), "0.5.3");
        assert!(versions_equal("v0.5.3", "0.5.3"));
    }

    #[test]
    fn builds_release_urls() {
        let url = release_download_url("v0.5.3", "aarch64-apple-darwin");
        assert_eq!(
            url,
            "https://github.com/poco-ai/Agentero/releases/download/v0.5.3/agentero-cli-0.5.3-aarch64-apple-darwin.tar.gz"
        );
        assert_eq!(
            release_sha256_url("0.5.3", "x86_64-pc-windows-msvc"),
            "https://github.com/poco-ai/Agentero/releases/download/v0.5.3/agentero-cli-0.5.3-x86_64-pc-windows-msvc.zip.sha256"
        );
        assert_eq!(archive_ext_for_triple("x86_64-pc-windows-msvc"), "zip");
        assert_eq!(archive_ext_for_triple("x86_64-unknown-linux-gnu"), "tar.gz");
    }

    #[test]
    fn parses_sha256sum_line() {
        let text = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef  agentero-cli-0.5.3-aarch64-apple-darwin.tar.gz\n";
        assert_eq!(
            parse_sha256_file(text).unwrap(),
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        );
    }

    #[test]
    fn rejects_bad_sha256() {
        assert!(parse_sha256_file("not-a-hash file\n").is_err());
        assert!(parse_sha256_file("").is_err());
    }

    #[test]
    fn extract_tar_gz_roundtrip() {
        let dir = std::env::temp_dir().join(format!(
            "agentero-cli-dl-tar-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("agentero");

        // Build a minimal tar.gz with a single `agentero` member.
        let mut tar_buf = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut tar_buf);
            let mut header = tar::Header::new_gnu();
            let data = b"#!/bin/sh\necho ok\n";
            header.set_size(data.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            builder
                .append_data(&mut header, "agentero", data.as_slice())
                .unwrap();
            builder.finish().unwrap();
        }
        let mut enc = GzEncoder::new(Vec::new(), Compression::default());
        enc.write_all(&tar_buf).unwrap();
        let gz = enc.finish().unwrap();

        extract_cli_binary(&gz, "agentero-cli-0.0.0-test.tar.gz", &dest).unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"#!/bin/sh\necho ok\n");
        let _ = fs::remove_dir_all(&dir);
    }
}
