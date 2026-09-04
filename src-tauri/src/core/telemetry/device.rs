//! Device-level facts reported alongside every event.
//!
//! Everything here is best-effort: a missing hardware model must never fail the
//! report. Nothing reads Vault paths, file names, or document content.

use crate::core::paths;

#[derive(Debug, Clone)]
pub(super) struct DeviceInfo {
    pub(super) os_name: String,
    pub(super) os_version: String,
    pub(super) arch: String,
    pub(super) device_model: Option<String>,
}

pub(super) fn collect_device_info() -> DeviceInfo {
    let info = os_info::get();
    DeviceInfo {
        os_name: info.os_type().to_string(),
        os_version: info.version().to_string(),
        arch: std::env::consts::ARCH.to_string(),
        device_model: device_model(),
    }
}

/// Stable anonymous install id (UUID v4 persisted in the config dir).
pub(super) fn install_id() -> String {
    let path = paths::agentero_config_dir().join("telemetry_id");
    if let Ok(raw) = std::fs::read_to_string(&path) {
        let id = raw.trim();
        if !id.is_empty() {
            return id.to_string();
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let _ = std::fs::create_dir_all(paths::agentero_config_dir());
    let _ = std::fs::write(&path, &id);
    id
}

/// Local UTC offset like `+08:00`.
pub(super) fn timezone_offset() -> String {
    chrono::Local::now().offset().to_string()
}

/// Best-effort hardware model (e.g. `Mac15,7`); never fails the report.
fn device_model() -> Option<String> {
    let model = raw_device_model()?.trim().to_string();
    (!model.is_empty()).then_some(model)
}

fn raw_device_model() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("sysctl")
            .args(["-n", "hw.model"])
            .output()
            .ok()?;
        Some(String::from_utf8_lossy(&out.stdout).into_owned())
    }
    #[cfg(target_os = "linux")]
    {
        std::fs::read_to_string("/sys/devices/virtual/dmi/id/product_name").ok()
    }
    #[cfg(target_os = "windows")]
    {
        let out = std::process::Command::new("reg")
            .args([
                "query",
                r"HKLM\HARDWARE\DESCRIPTION\System\BIOS",
                "/v",
                "SystemProductName",
            ])
            .output()
            .ok()?;
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .find_map(|line| line.split("REG_SZ").nth(1))
            .map(str::trim)
            .map(str::to_string)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        None
    }
}
