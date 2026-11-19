//! Mosaic's one HTTP stack (rustls), used for calendar feeds and update downloads, so there is a
//! single TLS and redirect policy to audit: HTTPS only, also after redirects, at most 5 of them.

use std::time::Duration;

/// A client for one kind of request; `timeout` bounds the whole request, body included.
pub fn client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(10))
        .timeout(timeout)
        .user_agent("Mosaic")
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 || attempt.url().scheme() != "https" {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|e| format!("couldn't start a download: {e}"))
}

/// Streams a successful response's body to `sink`, refusing more than `max` bytes. `sink` sees the
/// total so far after each chunk and can stop the download by returning an error.
pub async fn read_capped(
    mut response: reqwest::Response,
    max: u64,
    mut sink: impl FnMut(&[u8], u64) -> Result<(), String>,
) -> Result<u64, String> {
    if response.content_length().is_some_and(|len| len > max) {
        return Err("the download is larger than expected".into());
    }
    let mut total = 0u64;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "the download was interrupted".to_string())?
    {
        total = total.saturating_add(chunk.len() as u64);
        if total > max {
            return Err("the download is larger than expected".into());
        }
        sink(&chunk, total)?;
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_http_is_refused_before_anything_is_sent() {
        let client = client(Duration::from_secs(5)).unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        assert!(
            runtime
                .block_on(client.get("http://example.com/").send())
                .is_err()
        );
    }
}
