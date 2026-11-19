//! The app's HTTP helpers. The stack itself (TLS and redirect policy) lives in `mosaic_core::http`,
//! shared with calendar feeds; this adds the update downloader's metadata fetch.

pub(crate) use mosaic_core::http::{client, read_capped};

/// A whole small body (metadata), capped at `max` bytes.
pub(crate) async fn get_bytes(
    client: &reqwest::Client,
    url: &str,
    max: u64,
) -> Result<Vec<u8>, String> {
    let response = client
        .get(url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Couldn't reach GitHub (offline, rate-limited, or unavailable). Try again later. {e}"))?;
    let mut bytes = Vec::new();
    read_capped(response, max, |chunk, _| {
        bytes.extend_from_slice(chunk);
        Ok(())
    })
    .await?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn plain_http_is_refused_before_anything_is_sent() {
        let client = client(Duration::from_secs(5)).unwrap();
        let err = tauri::async_runtime::block_on(get_bytes(&client, "http://example.com/", 10))
            .unwrap_err();
        assert!(err.contains("Couldn't reach"), "{err}");
    }
}
