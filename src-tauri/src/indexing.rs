//! Owns derived-index recovery. At most three automatic retries (2/4/8 seconds), then an explicit
//! rebuild is required. The worker is stopped on vault replacement and never holds an app lock
//! while scanning. Diagnostics contain stable codes, not absolute paths or note content.
use mosaic_core::Workspace;
use mosaic_core::index_health::{IndexHealth, IndexStatus};
use mosaic_core::watch::{Changes, Watcher};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};

pub struct Monitor {
    stop: Arc<AtomicBool>,
    rebuild: Arc<AtomicBool>,
    worker: std::thread::Thread,
}
impl Monitor {
    pub fn request_rebuild(&self) {
        self.rebuild.store(true, Ordering::Release);
        self.worker.unpark();
    }
}
impl Drop for Monitor {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.worker.unpark();
    }
}

#[derive(Default)]
struct Retries {
    attempts: usize,
    next: Option<Instant>,
}
impl Retries {
    fn failed(&mut self, now: Instant) {
        self.next = [2, 4, 8]
            .get(self.attempts)
            .map(|seconds| now + Duration::from_secs(*seconds));
        self.attempts += 1;
    }
    fn ready(&self, now: Instant) -> bool {
        self.next.is_some_and(|next| now >= next)
    }
}

pub fn start(
    ws: Arc<Workspace>,
    changed: impl Fn(Changes) + Send + Sync + 'static,
    progress: impl Fn(usize, usize, bool, bool) + Send + 'static,
    health_changed: impl Fn(IndexHealth) + Send + 'static,
) -> Monitor {
    let stop = Arc::new(AtomicBool::new(false));
    let rebuild = Arc::new(AtomicBool::new(false));
    let stopped = stop.clone();
    let requested = rebuild.clone();
    let changed = Arc::new(changed);
    let worker = std::thread::spawn(move || {
        let mut watcher: Option<Watcher> = None;
        let mut retries = Retries::default();
        let mut last_health = None;
        let mut run = true;
        let mut was_healthy = false;
        let mut full = false;
        while !stopped.load(Ordering::Acquire) {
            if requested.swap(false, Ordering::AcqRel) {
                retries = Retries::default();
                run = true;
                full = true;
            }
            let health = ws.index_health();
            if was_healthy && health.status == IndexStatus::Degraded {
                retries = Retries::default();
                retries.failed(Instant::now());
                was_healthy = false;
            }
            if run || retries.ready(Instant::now()) {
                run = false;
                if !health.watching {
                    drop(watcher.take());
                    let changed = changed.clone();
                    let stopped = stopped.clone();
                    watcher = mosaic_core::watch::watch(ws.clone(), move |event| {
                        if !stopped.load(Ordering::Acquire) {
                            changed(event);
                        }
                    })
                    .ok(); // watch records a typed, redacted startup failure in Workspace.
                }
                if stopped.load(Ordering::Acquire) {
                    break;
                }
                let mut rebuilding = ws.index_health();
                rebuilding.status = IndexStatus::Rebuilding;
                health_changed(rebuilding);
                progress(0, 0, false, false);
                let report = |done, total| {
                    if !stopped.load(Ordering::Acquire) {
                        progress(done, total, false, false);
                    }
                };
                // Stops an obsolete scan between batches once this vault is replaced.
                let current = || !stopped.load(Ordering::Acquire);
                let result = if full {
                    ws.rebuild_index_cancellable(report, current)
                } else {
                    ws.sync_cancellable(report, current)
                };
                if stopped.load(Ordering::Acquire) {
                    break;
                }
                if result.is_ok() {
                    full = false;
                }
                progress(0, 0, true, result.is_err());
                if ws.index_health().status == IndexStatus::Healthy {
                    retries = Retries::default();
                    was_healthy = true;
                } else {
                    retries.failed(Instant::now());
                }
            }
            let health = ws.index_health();
            if last_health.as_ref() != Some(&health) {
                health_changed(health.clone());
                last_health = Some(health);
            }
            std::thread::park_timeout(Duration::from_millis(500));
        }
    });
    Monitor {
        stop,
        rebuild,
        worker: worker.thread().clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_manual_retry_recovers_a_failed_start_without_reopening_the_workspace() {
        use mosaic_core::{index::Index, vault::Vault};
        let root = tempfile::tempdir().unwrap();
        let ws = Arc::new(Workspace::new(
            Vault::open(root.path()).unwrap(),
            Index::in_memory().unwrap(),
        ));
        std::fs::remove_dir(root.path()).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let monitor = start(
            ws.clone(),
            |_| {},
            |_, _, _, _| {},
            move |health| {
                let _ = tx.send(health);
            },
        );
        loop {
            if rx.recv_timeout(Duration::from_secs(5)).unwrap().status == IndexStatus::Degraded {
                break;
            }
        }
        std::fs::create_dir(root.path()).unwrap();
        std::fs::write(root.path().join("recovered.md"), "otters").unwrap();
        monitor.request_rebuild();
        loop {
            if rx.recv_timeout(Duration::from_secs(5)).unwrap().status == IndexStatus::Healthy {
                break;
            }
        }
        assert_eq!(ws.search("otters", 5).unwrap()[0].path, "recovered.md");
    }

    #[test]
    fn retries_are_bounded_and_back_off_without_sleeping() {
        let mut retries = Retries::default();
        let now = Instant::now();
        for seconds in [2, 4, 8] {
            retries.failed(now);
            assert!(!retries.ready(now + Duration::from_secs(seconds - 1)));
            assert!(retries.ready(now + Duration::from_secs(seconds)));
        }
        retries.failed(now);
        assert!(!retries.ready(now + Duration::from_secs(10000)));
        retries = Retries::default();
        retries.failed(now);
        assert!(retries.ready(now + Duration::from_secs(2)));
    }
}
