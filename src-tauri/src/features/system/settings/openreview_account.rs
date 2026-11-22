use agentero_core::features::paper::import::openreview;
use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use tauri::webview::Cookie;
use tokio::sync::{Mutex, OnceCell};

const SERVICE: &str = "app.agentero.openreview";
const ACCOUNT: &str = "browser-session";
const REFRESH_EARLY_SECONDS: i64 = 60;
const RETRY_AFTER_SECONDS: i64 = 30;

#[derive(Serialize, Deserialize)]
struct Session {
    access: String,
    refresh: Option<String>,
    #[serde(skip)]
    rejected: bool,
}

struct State {
    session: Option<Session>,
    retry_after: i64,
}

static STATE: OnceCell<Mutex<State>> = OnceCell::const_new();

async fn state() -> &'static Mutex<State> {
    STATE
        .get_or_init(|| async {
            let session = tauri::async_runtime::spawn_blocking(|| {
                let secret = keyring::Entry::new(SERVICE, ACCOUNT)
                    .ok()?
                    .get_password()
                    .ok()?;
                serde_json::from_str(&secret).ok()
            })
            .await
            .ok()
            .flatten();
            Mutex::new(State {
                session,
                retry_after: 0,
            })
        })
        .await
}

async fn persist(session: &Session) -> Result<(), String> {
    let secret = serde_json::to_string(session)
        .map_err(|_| "Could not encode the OpenReview session".to_owned())?;
    tauri::async_runtime::spawn_blocking(move || {
        keyring::Entry::new(SERVICE, ACCOUNT)
            .and_then(|entry| entry.set_password(&secret))
            .map_err(|_| {
                "Could not save the OpenReview session in the system credential store".to_owned()
            })
    })
    .await
    .map_err(|_| "Could not access the system credential store".to_owned())?
}

pub(super) fn access_cookie<'a>(cookies: &'a [Cookie<'_>]) -> Option<&'a str> {
    account_cookie(cookies, openreview::ACCESS_COOKIE)
}

fn account_cookie<'a>(cookies: &'a [Cookie<'_>], name: &str) -> Option<&'a str> {
    let now = openreview::now_unix();
    cookies.iter().find_map(|cookie| {
        let domain = cookie.domain()?.trim_start_matches('.');
        (domain.eq_ignore_ascii_case("openreview.net")
            && cookie.name() == name
            && cookie.secure() != Some(false)
            && cookie
                .expires_datetime()
                .is_none_or(|expiry| expiry.unix_timestamp() > now)
            && openreview::jwt_expiry(cookie.value()).is_some_and(|exp| exp > now))
        .then(|| cookie.value())
    })
}

pub(super) async fn capture(cookies: &[Cookie<'_>]) -> Result<bool, String> {
    let Some(access) = access_cookie(cookies) else {
        return Ok(false);
    };
    let refresh = account_cookie(cookies, openreview::REFRESH_COOKIE);
    let mut state = state().await.lock().await;
    if let Some(cached) = &state.session {
        if cached.access == access && cached.refresh.as_deref() == refresh {
            return Ok(!cached.rejected);
        }
    }
    let session = Session {
        access: access.to_owned(),
        refresh: refresh.map(str::to_owned),
        rejected: false,
    };
    persist(&session).await?;
    state.session = Some(session);
    state.retry_after = 0;
    Ok(true)
}

pub(super) async fn session_expiry() -> Option<i64> {
    let state = state().await.lock().await;
    let session = state.session.as_ref()?;
    [
        if session.rejected {
            Some(0)
        } else {
            openreview::jwt_expiry(&session.access)
        },
        session.refresh.as_deref().and_then(openreview::jwt_expiry),
    ]
    .into_iter()
    .flatten()
    .max()
}

pub(super) fn access_token(rejected: Option<String>) -> BoxFuture<'static, Option<String>> {
    Box::pin(async move {
        // Downloads share the same session, including when the server rotates
        // its refresh token. Keep just one refresh in flight.
        let mut state = state().await.lock().await;
        let now = openreview::now_unix();
        let retry_after = state.retry_after;
        let session = state.session.as_mut()?;
        let expiry = openreview::jwt_expiry(&session.access)?;
        session.rejected |= rejected.as_deref() == Some(session.access.as_str());
        if !session.rejected && expiry > now + REFRESH_EARLY_SECONDS {
            return Some(session.access.clone());
        }
        let refresh = session
            .refresh
            .as_deref()
            .filter(|token| openreview::jwt_expiry(token).is_some_and(|exp| exp > now));
        if let Some(refresh) = refresh.filter(|_| now >= retry_after) {
            if let Some((access, rotated)) = openreview::refresh_account(refresh).await {
                if openreview::jwt_expiry(&access).is_some_and(|exp| exp > openreview::now_unix()) {
                    session.access = access;
                    session.rejected = false;
                    if let Some(rotated) = rotated {
                        session.refresh = Some(rotated);
                    }
                    // A temporarily locked keyring must not discard a newly
                    // issued in-memory session.
                    let _ = persist(session).await;
                    return Some(session.access.clone());
                }
            }
            let usable = (!session.rejected && expiry > openreview::now_unix())
                .then(|| session.access.clone());
            state.retry_after = openreview::now_unix() + RETRY_AFTER_SECONDS;
            return usable;
        }
        (!session.rejected && expiry > openreview::now_unix()).then(|| session.access.clone())
    })
}
