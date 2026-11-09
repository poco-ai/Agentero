//! System-level application features.

#[cfg(feature = "desktop")]
pub mod builtin;
#[cfg(feature = "desktop")]
pub mod desktop_apps;
#[cfg(feature = "desktop")]
pub mod network;
#[cfg(feature = "desktop")]
pub mod settings;
#[cfg(all(
    feature = "desktop",
    not(any(target_os = "android", target_os = "ios"))
))]
pub mod updater;
