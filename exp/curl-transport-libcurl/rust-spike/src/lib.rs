use curl::easy::{Easy2, Handler, WriteError};
use napi::{Error, Result, Status};
use napi_derive::napi;

struct Collector(Vec<u8>);

impl Handler for Collector {
    fn write(&mut self, data: &[u8]) -> std::result::Result<usize, WriteError> {
        self.0.extend_from_slice(data);
        Ok(data.len())
    }
}

fn native_error(error: impl std::fmt::Display) -> Error {
    Error::new(Status::GenericFailure, error.to_string())
}

/// Minimal feasibility spike only: execute libcurl on Tokio's blocking pool so the JS event loop is not blocked.
/// A production transport would expose streaming chunks through a napi ThreadsafeFunction and use Multi for pooling.
#[napi]
pub async fn get_https(url: String) -> Result<String> {
    tokio::task::spawn_blocking(move || -> Result<String> {
        let mut easy = Easy2::new(Collector(Vec::new()));
        easy.url(&url).map_err(native_error)?;
        easy.http_version(curl::easy::HttpVersion::V2TLS).map_err(native_error)?;
        easy.perform().map_err(native_error)?;
        String::from_utf8(easy.get_ref().0.clone()).map_err(native_error)
    })
    .await
    .map_err(native_error)?
}
