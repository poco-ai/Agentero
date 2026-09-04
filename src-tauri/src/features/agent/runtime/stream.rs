//! Coalesce ACP streaming text chunks before emitting `agent:stream`.
//!
//! Agents typically deliver 20–100 tiny `AgentMessageChunk`/`AgentThoughtChunk`
//! notifications per second. Emitting each one across the Tauri IPC bridge
//! forces a webview store update per token, which is the main source of
//! renderer jank on Windows. The coalescer buffers consecutive same-kind
//! chunks and flushes them on a short timer, so the payload shape stays the
//! same — the text is just longer and the event rate ~25/s instead of 100/s.
//!
//! Ordering guarantees:
//! - a kind switch (message ↔ thought) flushes the pending buffer first;
//! - callers must [`StreamCoalescer::flush`] before any ordered event
//!   (tool/plan updates, `agent:completed`, `agent:failed`) so buffered text
//!   always lands before it.

use crate::features::agent::models::AgentStreamKind;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

/// Default flush window: long enough to merge a burst of tokens, short enough
/// to stay imperceptible while streaming.
pub const STREAM_COALESCE_WINDOW: Duration = Duration::from_millis(40);

struct CoalesceBuf {
    text: String,
    kind: AgentStreamKind,
    timer_scheduled: bool,
}

struct Inner {
    buf: Mutex<CoalesceBuf>,
    emit: Box<dyn Fn(String, AgentStreamKind) + Send + Sync>,
    window: Duration,
    handle: tokio::runtime::Handle,
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, CoalesceBuf> {
        match self.buf.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    /// Emit the pending buffer while holding the lock (keeps chunk order).
    fn flush_locked(&self, buf: &mut CoalesceBuf) {
        if buf.text.is_empty() {
            return;
        }
        let text = std::mem::take(&mut buf.text);
        (self.emit)(text, buf.kind);
    }
}

/// Merges consecutive streaming text chunks into windowed emits.
#[derive(Clone)]
pub struct StreamCoalescer {
    inner: Arc<Inner>,
}

impl StreamCoalescer {
    /// Must be constructed inside a tokio runtime: the delayed-flush timer
    /// task is spawned on the runtime captured here.
    pub fn new(
        window: Duration,
        emit: impl Fn(String, AgentStreamKind) + Send + Sync + 'static,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                buf: Mutex::new(CoalesceBuf {
                    text: String::new(),
                    kind: AgentStreamKind::Message,
                    timer_scheduled: false,
                }),
                emit: Box::new(emit),
                window,
                handle: tokio::runtime::Handle::current(),
            }),
        }
    }

    /// Append a chunk. A kind switch flushes the pending buffer first so
    /// message/thought interleaving is preserved.
    pub fn push(&self, chunk: &str, kind: AgentStreamKind) {
        let mut buf = self.inner.lock();
        if buf.kind != kind {
            self.inner.flush_locked(&mut buf);
            buf.kind = kind;
        }
        buf.text.push_str(chunk);
        if !buf.timer_scheduled {
            buf.timer_scheduled = true;
            let inner = self.inner.clone();
            self.inner.handle.spawn(async move {
                tokio::time::sleep(inner.window).await;
                let mut buf = inner.lock();
                buf.timer_scheduled = false;
                inner.flush_locked(&mut buf);
            });
        }
    }

    /// Emit any buffered text immediately. Call before ordered events
    /// (tool/plan/completed/failed) so text never arrives after them.
    pub fn flush(&self) {
        let mut buf = self.inner.lock();
        self.inner.flush_locked(&mut buf);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    type Emitted = Arc<Mutex<Vec<(String, AgentStreamKind)>>>;

    fn collector() -> (
        Emitted,
        impl Fn(String, AgentStreamKind) + Send + Sync + 'static,
    ) {
        let emitted: Emitted = Arc::new(Mutex::new(Vec::new()));
        let sink = emitted.clone();
        (emitted, move |text, kind| {
            sink.lock().unwrap().push((text, kind));
        })
    }

    /// 200 chunks at 10ms intervals with a 40ms window must merge to far
    /// fewer emits than 200 while the concatenated text stays lossless.
    #[tokio::test(start_paused = true)]
    async fn coalesces_token_storm_losslessly() {
        let (emitted, sink) = collector();
        let coalescer = StreamCoalescer::new(Duration::from_millis(40), sink);

        let mut expected = String::new();
        for i in 0..200 {
            let chunk = format!("tok{i} ");
            expected.push_str(&chunk);
            coalescer.push(&chunk, AgentStreamKind::Message);
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        coalescer.flush();

        let events = emitted.lock().unwrap();
        let joined: String = events.iter().map(|(text, _)| text.as_str()).collect();
        assert_eq!(joined, expected, "coalesced text must be lossless");
        assert!(
            events
                .iter()
                .all(|(_, kind)| *kind == AgentStreamKind::Message),
            "kind must be preserved"
        );
        // 40ms window over 10ms chunks → ~50 emits; leave headroom for timer
        // scheduling boundaries but require a clear reduction from 200.
        assert!(
            events.len() <= 80,
            "expected <=80 coalesced emits for 200 chunks, got {}",
            events.len()
        );
        assert!(events.len() >= 2, "storm must not collapse to one emit");
        println!(
            "coalesced 200 chunks into {} emits (window 40ms, cadence 10ms)",
            events.len()
        );
    }

    /// Switching message ↔ thought flushes the pending buffer first so the
    /// frontend never sees interleaving reordered.
    #[tokio::test(start_paused = true)]
    async fn kind_switch_flushes_in_order() {
        let (emitted, sink) = collector();
        let coalescer = StreamCoalescer::new(Duration::from_millis(40), sink);

        coalescer.push("thinking…", AgentStreamKind::Thought);
        coalescer.push("answer A", AgentStreamKind::Message);
        coalescer.push(" answer B", AgentStreamKind::Message);
        coalescer.flush();

        let events = emitted.lock().unwrap().clone();
        assert_eq!(
            events,
            vec![
                ("thinking…".to_string(), AgentStreamKind::Thought),
                ("answer A answer B".to_string(), AgentStreamKind::Message),
            ]
        );
    }

    /// An explicit flush (ordered event boundary) emits pending text at once,
    /// and the stale timer that fires later must not duplicate anything.
    #[tokio::test(start_paused = true)]
    async fn explicit_flush_beats_timer_without_duplication() {
        let (emitted, sink) = collector();
        let coalescer = StreamCoalescer::new(Duration::from_millis(40), sink);

        coalescer.push("before tool", AgentStreamKind::Message);
        coalescer.flush();
        assert_eq!(
            emitted.lock().unwrap().as_slice(),
            &[("before tool".to_string(), AgentStreamKind::Message)]
        );

        // Let the already-scheduled timer fire: buffer is empty, no emit.
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(emitted.lock().unwrap().len(), 1);

        // Buffer keeps working after the boundary.
        coalescer.push("after tool", AgentStreamKind::Message);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(
            emitted.lock().unwrap().last().unwrap(),
            &("after tool".to_string(), AgentStreamKind::Message)
        );
    }

    /// Text shorter than one window is still delivered by the timer alone.
    #[tokio::test(start_paused = true)]
    async fn timer_flushes_trailing_text() {
        let (emitted, sink) = collector();
        let coalescer = StreamCoalescer::new(Duration::from_millis(40), sink);

        coalescer.push("tail", AgentStreamKind::Message);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(
            emitted.lock().unwrap().as_slice(),
            &[("tail".to_string(), AgentStreamKind::Message)]
        );
    }
}
