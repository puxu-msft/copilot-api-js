use std::time::Duration;

use http_body_util::BodyExt;
use napi::{Error, Result, Status};
use napi_derive::napi;
use reqwest::Client;

fn native_error(error: impl std::fmt::Display) -> Error {
    Error::new(Status::GenericFailure, error.to_string())
}

#[napi(object)]
pub struct ProbeResult {
    pub status: u32,
    pub http_version: String,
    pub body: String,
    pub trailers_json: String,
}

/// Minimal feasibility spike. The real provider would retain this client in native state,
/// expose incremental body frames to JS, map h2 error reasons, and support explicit proxies.
#[napi]
pub async fn probe_h2(url: String, ping_interval_ms: u32) -> Result<ProbeResult> {
    let client = Client::builder()
        .http2_prior_knowledge()
        .http2_keep_alive_interval(Duration::from_millis(u64::from(ping_interval_ms)))
        .http2_keep_alive_timeout(Duration::from_secs(2))
        .http2_keep_alive_while_idle(true)
        .tcp_keepalive(Duration::from_secs(15))
        .pool_idle_timeout(Duration::from_secs(90))
        .no_proxy()
        .build()
        .map_err(native_error)?;

    let response = client.get(url).send().await.map_err(native_error)?;
    let status = u32::from(response.status().as_u16());
    let http_version = format!("{:?}", response.version());
    let response: http::Response<reqwest::Body> = response.into();
    let mut body = response.into_body();
    let mut body_bytes = Vec::new();
    let mut trailers = Vec::new();

    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(native_error)?;
        let frame = match frame.into_data() {
            Ok(data) => {
                body_bytes.extend_from_slice(&data);
                continue;
            }
            Err(frame) => frame,
        };
        if let Ok(map) = frame.into_trailers() {
            for (name, value) in &map {
                trailers.push(format!("{}={}", name, value.to_str().unwrap_or("<binary>")));
            }
        }
    }

    Ok(ProbeResult {
        status,
        http_version,
        body: String::from_utf8(body_bytes).map_err(native_error)?,
        trailers_json: format!("{:?}", trailers),
    })
}
