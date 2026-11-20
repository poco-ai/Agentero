//! Offline integration tests for `agentero sync` (no network): config
//! resolution, unconfigured errors and the secret-channel guard. The engine
//! itself (merge / conflicts / resume) is covered by the in-memory-store
//! tests in `agentero-core::features::sync`.

use assert_cmd::cargo::cargo_bin_cmd;
use predicates::prelude::*;
use std::fs;
use std::path::Path;
use tempfile::tempdir;

fn agentero() -> assert_cmd::Command {
    cargo_bin_cmd!("agentero-cli")
}

fn create_vault(dir: &Path) {
    let home = dir.parent().unwrap_or(dir).join(".test-home");
    fs::create_dir_all(&home).unwrap();
    agentero()
        .env("HOME", &home)
        .env("XDG_CONFIG_HOME", home.join(".config"))
        .args(["vault", "create", dir.to_str().unwrap(), "--json"])
        .assert()
        .success()
        .stdout(predicate::str::contains("\"outcome\":\"created\""));
}

#[test]
fn sync_status_reports_unconfigured_vault() {
    let tmp = tempdir().unwrap();
    let vault = tmp.path().join("vault");
    create_vault(&vault);

    agentero()
        .env("HOME", tmp.path().join(".test-home"))
        .env("XDG_CONFIG_HOME", tmp.path().join(".test-home/.config"))
        .args([
            "sync",
            "status",
            "--vault",
            vault.to_str().unwrap(),
            "--json",
        ])
        .assert()
        .code(0)
        .stdout(predicate::str::contains("\"backend\":null"))
        .stdout(predicate::str::contains("\"last_run\":null"));
}

#[test]
fn sync_now_without_binding_fails_with_stable_code() {
    let tmp = tempdir().unwrap();
    let vault = tmp.path().join("vault");
    create_vault(&vault);

    agentero()
        .env("HOME", tmp.path().join(".test-home"))
        .env("XDG_CONFIG_HOME", tmp.path().join(".test-home/.config"))
        .args(["sync", "run", "--vault", vault.to_str().unwrap(), "--json"])
        .assert()
        .code(1)
        .stderr(predicate::str::contains("\"code\":\"sync_not_configured\""));
}

#[test]
fn sync_configure_never_prompts_or_leaks_secret_guidance_in_json_mode() {
    let tmp = tempdir().unwrap();
    let vault = tmp.path().join("vault");
    create_vault(&vault);

    // Non-TTY + no env secrets: must fail (not hang on a prompt) and point
    // at the secret channels instead of argv.
    agentero()
        .env("HOME", tmp.path().join(".test-home"))
        .env("XDG_CONFIG_HOME", tmp.path().join(".test-home/.config"))
        .args([
            "sync",
            "connect",
            "s3",
            "--vault",
            vault.to_str().unwrap(),
            "--endpoint",
            "https://example.r2.cloudflarestorage.com",
            "--bucket",
            "b",
            "--json",
        ])
        .assert()
        .code(1)
        .stderr(predicate::str::contains("\"code\":\"sync_config_invalid\""))
        .stderr(predicate::str::contains("--credentials-input"));
}

#[test]
fn sync_configure_rejects_plain_http_endpoint_via_stdin() {
    let tmp = tempdir().unwrap();
    let vault = tmp.path().join("vault");
    create_vault(&vault);

    let cfg = r#"{
        "backend": "s3",
        "endpoint": "http://minio.example.com",
        "bucket": "b",
        "access_key": "a",
        "secret_key": "s"
    }"#;
    let mut cmd = agentero();
    cmd.env("HOME", tmp.path().join(".test-home"))
        .env("XDG_CONFIG_HOME", tmp.path().join(".test-home/.config"))
        .args([
            "sync",
            "connect",
            "s3",
            "--vault",
            vault.to_str().unwrap(),
            "--endpoint",
            "http://minio.example.com",
            "--bucket",
            "b",
            "--credentials-input",
            "-",
            "--json",
        ])
        .write_stdin(cfg)
        .assert()
        .code(1)
        .stderr(predicate::str::contains("must use https"));
}

fn git_available() -> bool {
    std::process::Command::new("git")
        .arg("--version")
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

#[test]
fn sync_configure_git_pushes_to_a_local_bare_remote() {
    if !git_available() {
        return;
    }
    let tmp = tempdir().unwrap();
    let vault = tmp.path().join("vault");
    create_vault(&vault);
    let home = tmp.path().join(".test-home");
    let remote = tmp.path().join("remote.git");
    let init = std::process::Command::new("git")
        .args(["init", "--bare"])
        .arg(&remote)
        .output()
        .unwrap();
    assert!(init.status.success());

    fs::write(vault.join("note.md"), "# hi\n").unwrap();

    agentero()
        .env("HOME", &home)
        .env("XDG_CONFIG_HOME", home.join(".config"))
        .args([
            "sync",
            "connect",
            "git",
            "--vault",
            vault.to_str().unwrap(),
            remote.to_str().unwrap(),
            "--branch",
            "main",
            "--json",
        ])
        .assert()
        .success()
        .stdout(predicate::str::contains("\"backend\":\"git\""))
        .stdout(predicate::str::contains("\"location\":"));

    agentero()
        .env("HOME", &home)
        .env("XDG_CONFIG_HOME", home.join(".config"))
        .args(["sync", "run", "--vault", vault.to_str().unwrap(), "--json"])
        .assert()
        .success()
        .stdout(predicate::str::contains("\"uploaded\":"));

    let tree = std::process::Command::new("git")
        .args([
            "--git-dir",
            remote.to_str().unwrap(),
            "ls-tree",
            "-r",
            "--name-only",
            "main",
        ])
        .output()
        .unwrap();
    assert!(tree.status.success());
    let tree = String::from_utf8_lossy(&tree.stdout);
    assert!(tree.contains("note.md"), "{tree}");
    assert!(!tree.contains(".agentero"), "{tree}");
}

#[test]
fn sync_test_and_disconnect_without_binding_fail_fast() {
    let tmp = tempdir().unwrap();
    let vault = tmp.path().join("vault");
    create_vault(&vault);

    for sub in ["test", "disconnect"] {
        agentero()
            .env("HOME", tmp.path().join(".test-home"))
            .env("XDG_CONFIG_HOME", tmp.path().join(".test-home/.config"))
            .args(["sync", sub, "--vault", vault.to_str().unwrap(), "--json"])
            .assert()
            .code(1)
            .stderr(predicate::str::contains("\"code\":\"sync_not_configured\""));
    }
}
