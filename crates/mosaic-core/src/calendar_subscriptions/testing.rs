//! Test doubles for [`CalendarSubscriptions`](super::CalendarSubscriptions): an in-memory
//! [`SecretStore`] and a [`FeedFetcher`] that answers from a script. Only in test builds and with
//! the `test-support` feature, so other crates (`mosaic-cli`) can test their wrappers without the
//! Keychain or the network.

use super::{DownloadedFeed, FeedFetcher, SecretStore, Url, Validators};
use crate::{Error, Result};
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

/// Secrets kept in memory, by id.
#[derive(Debug, Default)]
pub struct MemorySecrets(pub Mutex<HashMap<String, String>>);

impl MemorySecrets {
    /// Every stored secret, by id.
    pub fn all(&self) -> HashMap<String, String> {
        self.0.lock().unwrap().clone()
    }
}

impl SecretStore for MemorySecrets {
    fn set(&self, id: &str, value: &str) -> Result<()> {
        self.0.lock().unwrap().insert(id.into(), value.into());
        Ok(())
    }
    fn get(&self, id: &str) -> Result<String> {
        self.0
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| Error::Invalid("missing secret".into()))
    }
    fn delete(&self, id: &str) {
        self.0.lock().unwrap().remove(id);
    }
}

/// Answers each download with the next scripted response and records what was asked for. A
/// download with nothing scripted panics.
#[derive(Debug, Default)]
pub struct ScriptedFetcher {
    pub responses: Mutex<VecDeque<Result<Option<DownloadedFeed>>>>,
    pub calls: Mutex<Vec<(String, Validators)>>,
}

impl ScriptedFetcher {
    /// Queues the answer to the next download.
    pub fn respond(&self, response: Result<Option<DownloadedFeed>>) {
        self.responses.lock().unwrap().push_back(response);
    }

    /// The downloads asked for since the last call: each URL and its validators.
    pub fn take_calls(&self) -> Vec<(String, Validators)> {
        std::mem::take(&mut self.calls.lock().unwrap())
    }
}

impl FeedFetcher for ScriptedFetcher {
    async fn fetch(&self, url: Url, validators: &Validators) -> Result<Option<DownloadedFeed>> {
        self.calls
            .lock()
            .unwrap()
            .push((url.to_string(), validators.clone()));
        self.responses
            .lock()
            .unwrap()
            .pop_front()
            .expect("no download was expected")
    }
}
