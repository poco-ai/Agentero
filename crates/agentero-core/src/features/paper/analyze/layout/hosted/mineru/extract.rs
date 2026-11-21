//! Share one in-flight provider extraction between body and layout consumers.
//! A shared future runs only while a consumer polls it: cancelling one waiter
//! leaves the others running, and dropping the last waiter drops the HTTP work.

use super::{AppError, HostedProviderCredentials, MINERU_DEFAULT_LANGUAGE, MINERU_POLL_INTERVAL};
use futures_util::future::{BoxFuture, Shared};
use futures_util::FutureExt;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, Weak};
use tokio::sync::watch;

type Key = [u8; 32];
type Progress = Option<(String, Option<u64>, Option<u64>)>;
type ExtractResult = Result<Arc<Vec<u8>>, Arc<AppError>>;

struct Flight {
    result: Shared<BoxFuture<'static, ExtractResult>>,
    progress: watch::Receiver<Progress>,
}

#[derive(Default)]
struct Flights(Mutex<HashMap<Key, Weak<Flight>>>);

impl Flights {
    fn get_or_start(
        &self,
        key: Key,
        start: impl FnOnce(watch::Sender<Progress>) -> BoxFuture<'static, ExtractResult>,
    ) -> Arc<Flight> {
        let mut flights = self.0.lock().unwrap_or_else(|e| e.into_inner());
        // Weak entries never retain PDF bytes, credentials or result ZIPs.
        flights.retain(|_, flight| flight.strong_count() > 0);
        if let Some(flight) = flights.get(&key).and_then(Weak::upgrade) {
            return flight;
        }
        let (progress, receiver) = watch::channel(None);
        let flight = Arc::new(Flight {
            result: start(progress).shared(),
            progress: receiver,
        });
        flights.insert(key, Arc::downgrade(&flight));
        flight
    }
}

fn request_key(
    credentials: &HostedProviderCredentials,
    pdf_bytes: &[u8],
    file_name: &str,
) -> Result<Key, AppError> {
    let (base, auth) = super::resolve_target(credentials)?;
    let language = credentials
        .language
        .as_deref()
        .map(str::trim)
        .filter(|language| !language.is_empty())
        .unwrap_or(MINERU_DEFAULT_LANGUAGE);
    let mut digest = Sha256::new();
    // Length prefixes avoid ambiguous concatenation; no credentials or their
    // digest are persisted or logged. Different accounts never share work.
    for part in [
        base.as_bytes(),
        auth.as_bytes(),
        language.as_bytes(),
        file_name.as_bytes(),
        pdf_bytes,
    ] {
        digest.update((part.len() as u64).to_le_bytes());
        digest.update(part);
    }
    digest.update([
        u8::from(credentials.is_ocr),
        u8::from(credentials.self_hosted),
    ]);
    Ok(digest.finalize().into())
}

pub(super) async fn run(
    credentials: &HostedProviderCredentials,
    pdf_bytes: Vec<u8>,
    file_name: &str,
    progress: super::super::ProgressFn<'_>,
    cancel: super::super::CancelFn<'_>,
) -> Result<Arc<Vec<u8>>, AppError> {
    if cancel() {
        return Err(AppError::message(super::CANCELLED_MESSAGE));
    }
    static FLIGHTS: OnceLock<Flights> = OnceLock::new();
    let key = request_key(credentials, &pdf_bytes, file_name)?;
    let credentials = credentials.clone();
    let file_name = file_name.to_string();
    let flight = FLIGHTS
        .get_or_init(Flights::default)
        .get_or_start(key, |updates| {
            async move {
                super::run_mineru_extract_unshared(
                    &credentials,
                    pdf_bytes,
                    &file_name,
                    &|phase, extracted, total| {
                        updates.send_replace(Some((phase.to_string(), extracted, total)));
                    },
                    // Cancellation is per subscriber. When every subscriber leaves,
                    // dropping the Shared future cancels the provider request.
                    &|| false,
                )
                .await
                .map(Arc::new)
                .map_err(Arc::new)
            }
            .boxed()
        });
    wait(flight, progress, cancel).await
}

async fn wait(
    flight: Arc<Flight>,
    progress: super::super::ProgressFn<'_>,
    cancel: super::super::CancelFn<'_>,
) -> Result<Arc<Vec<u8>>, AppError> {
    let mut result = flight.result.clone();
    let mut updates = flight.progress.clone();
    let mut progress_open = true;
    if let Some((phase, extracted, total)) = updates.borrow_and_update().as_ref() {
        progress(phase, *extracted, *total);
    }
    // The existing body-parser cancellation API is a synchronous predicate;
    // preserve the provider polling cadence while also checking on progress.
    let mut cancellation_check = tokio::time::interval(MINERU_POLL_INTERVAL);
    let output = loop {
        if cancel() {
            return Err(AppError::message(super::CANCELLED_MESSAGE));
        }
        tokio::select! {
            output = &mut result => break output,
            changed = updates.changed(), if progress_open => {
                if changed.is_err() {
                    progress_open = false;
                    continue;
                }
                if let Some((phase, extracted, total)) = updates.borrow_and_update().as_ref() {
                    progress(phase, *extracted, *total);
                }
            },
            _ = cancellation_check.tick() => {},
        }
    };
    output.map_err(|error| AppError::domain(error.code(), error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    #[tokio::test]
    async fn concurrent_consumers_share_the_result_and_failed_work_can_retry() {
        let flights = Flights::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let called = calls.clone();
        let progress_seen = Arc::new(tokio::sync::Semaphore::new(0));
        let both_consumers = progress_seen.clone();
        let first = flights.get_or_start([1; 32], |updates| {
            async move {
                called.fetch_add(1, Ordering::SeqCst);
                updates.send_replace(Some(("running".into(), Some(1), Some(2))));
                let _permit = both_consumers.acquire_many(2).await.unwrap();
                Ok(Arc::new(vec![1, 2, 3]))
            }
            .boxed()
        });
        let second = flights.get_or_start([1; 32], |_| panic!("must join existing work"));
        let progress = |phase: &str, extracted, total| {
            assert_eq!((phase, extracted, total), ("running", Some(1), Some(2)));
            progress_seen.add_permits(1);
        };
        let (a, b) = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            tokio::join!(
                wait(first, &progress, &|| false),
                wait(second, &progress, &|| false)
            )
        })
        .await
        .expect("both consumers receive progress and the result");
        assert!(Arc::ptr_eq(&a.unwrap(), &b.unwrap()));
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        let failed = flights.get_or_start([1; 32], |_| {
            async { Err(Arc::new(AppError::message("failure"))) }.boxed()
        });
        assert!(wait(failed, &|_, _, _| {}, &|| false).await.is_err());
        let retry = flights.get_or_start([1; 32], |_| async { Ok(Arc::new(vec![4])) }.boxed());
        assert_eq!(
            *wait(retry, &|_, _, _| {}, &|| false).await.unwrap(),
            vec![4]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn cancelling_one_subscriber_keeps_the_other_and_last_drop_stops_work() {
        struct Dropped(Arc<AtomicBool>);
        impl Drop for Dropped {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let flights = Flights::default();
        let stopped = Arc::new(AtomicBool::new(false));
        let started = Arc::new(tokio::sync::Notify::new());
        let did_start = started.clone();
        let guard = Dropped(stopped.clone());
        let first = flights.get_or_start([2; 32], |_| {
            async move {
                let _guard = guard;
                did_start.notify_one();
                futures_util::future::pending().await
            }
            .boxed()
        });
        let second = flights.get_or_start([2; 32], |_| panic!("must join"));
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancel_first = cancelled.clone();
        let first_waiter = tokio::spawn(async move {
            wait(first, &|_, _, _| {}, &|| {
                cancel_first.load(Ordering::SeqCst)
            })
            .await
        });
        let second_waiter =
            tokio::spawn(async move { wait(second, &|_, _, _| {}, &|| false).await });
        started.notified().await;
        cancelled.store(true, Ordering::SeqCst);
        tokio::time::advance(MINERU_POLL_INTERVAL).await;
        assert!(first_waiter.await.unwrap().is_err());
        assert!(!stopped.load(Ordering::SeqCst));
        assert!(!second_waiter.is_finished());
        second_waiter.abort();
        assert!(second_waiter.await.unwrap_err().is_cancelled());
        assert!(stopped.load(Ordering::SeqCst));
    }

    #[test]
    fn account_options_filename_and_pdf_are_part_of_the_identity() {
        let original = HostedProviderCredentials {
            api_key: Some("test-key-a".into()),
            ..Default::default()
        };
        let key = request_key(&original, b"pdf-a", "paper.pdf").unwrap();
        let mut changed = original.clone();
        changed.api_key = Some("test-key-b".into());
        assert_ne!(key, request_key(&changed, b"pdf-a", "paper.pdf").unwrap());
        changed = original.clone();
        changed.is_ocr = true;
        assert_ne!(key, request_key(&changed, b"pdf-a", "paper.pdf").unwrap());
        changed = original.clone();
        changed.language = Some("en".into());
        assert_ne!(key, request_key(&changed, b"pdf-a", "paper.pdf").unwrap());
        assert_ne!(key, request_key(&original, b"pdf-b", "paper.pdf").unwrap());
        assert_ne!(key, request_key(&original, b"pdf-a", "other.pdf").unwrap());
    }
}
