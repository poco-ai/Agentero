//! Desktop identity is independent of local Vault access. The upstream plugin
//! owns PKCE, keychain persistence, callback claims and response token scrubbing.
use tauri_plugin_better_auth::{AuthRouteKind, Transport};

const AUTH_ROUTES: &[(&str, &str)] = &[
    ("GET", "/organization/list"),
    ("GET", "/organization/get-full-organization"),
    ("GET", "/organization/list-members"),
    ("GET", "/organization/list-invitations"),
    ("GET", "/organization/list-user-invitations"),
    ("GET", "/organization/get-invitation"),
    ("GET", "/organization/get-active-member"),
    ("GET", "/organization/get-active-member-role"),
    ("POST", "/organization/create"),
    ("POST", "/organization/update"),
    ("POST", "/organization/delete"),
    ("POST", "/organization/leave"),
    ("POST", "/organization/invite-member"),
    ("POST", "/organization/cancel-invitation"),
    ("POST", "/organization/accept-invitation"),
    ("POST", "/organization/reject-invitation"),
    ("POST", "/organization/update-member-role"),
    ("POST", "/organization/remove-member"),
    ("POST", "/organization/check-slug"),
    ("POST", "/organization/has-permission"),
    ("POST", "/revoke-other-sessions"),
];

pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    // Only an explicitly compiled debug build can talk to the isolated fixtures.
    // A release ignores this build environment variable unconditionally.
    let local = cfg!(debug_assertions) && option_env!("AGENTERO_LOCAL_AUTH") == Some("1");
    let (api, web) = if local {
        ("http://localhost:8788", "http://localhost:5174")
    } else {
        ("https://api.agentero.app", "https://app.agentero.app")
    };
    let mut builder = tauri_plugin_better_auth::Builder::new()
        .base_url(format!("{api}/api/auth"))
        .sign_in_url(format!("{web}/desktop"))
        .scheme("agentero")
        .client_id("app.agentero.desktop")
        // `tauri dev` is a bare binary under target/. macOS only delivers
        // agentero:// to an installed .app, so a forced deep link completes in
        // the release bundle and leaves this process waiting. Auto uses
        // loopback for that dev process and deep links for an installed app.
        .transport(if local {
            Transport::Loopback
        } else {
            Transport::Auto
        })
        .api_routes(api, ["/api/desktop/transfer-ownership", "/api/writing/"]);
    for (method, path) in AUTH_ROUTES {
        builder = builder.auth_route(*method, *path, AuthRouteKind::Passthrough);
    }
    builder.build()
}
