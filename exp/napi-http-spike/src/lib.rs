use std::{
    collections::HashMap,
    sync::{
        Mutex,
        atomic::{AtomicU32, Ordering},
    },
    time::{Duration, Instant},
};

use futures_util::StreamExt;
use napi::{
    Status,
    bindgen_prelude::Function,
    threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
};
use napi_derive::napi;
use tokio_util::sync::CancellationToken;

static NEXT_REQUEST_ID: AtomicU32 = AtomicU32::new(1);
static REQUESTS: std::sync::LazyLock<Mutex<HashMap<u32, CancellationToken>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
static ACTIVE_TASKS: AtomicU32 = AtomicU32::new(0);
static RUNTIME: std::sync::LazyLock<tokio::runtime::Runtime> = std::sync::LazyLock::new(|| {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .worker_threads(2)
        .thread_name("napi-http-spike")
        .build()
        .expect("create spike tokio runtime")
});

fn native_error(error: impl std::fmt::Display) -> napi::Error {
    napi::Error::new(Status::GenericFailure, error.to_string())
}

fn make_client(http2: bool, tcp_keepalive_ms: Option<u32>) -> napi::Result<reqwest::Client> {
    let mut builder = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .pool_idle_timeout(Duration::from_secs(30));
    if http2 {
        builder = builder
            .http2_keep_alive_interval(Duration::from_secs(1))
            .http2_keep_alive_timeout(Duration::from_secs(2))
            .http2_keep_alive_while_idle(false);
    }
    if let Some(ms) = tcp_keepalive_ms {
        let duration = Duration::from_millis(ms as u64);
        builder = builder
            .tcp_keepalive(duration)
            .tcp_keepalive_interval(duration)
            .tcp_keepalive_retries(3);
    }
    builder.build().map_err(native_error)
}

#[napi(object)]
pub struct StartRequestOptions {
    pub url: String,
    pub http2: Option<bool>,
    pub tcp_keepalive_ms: Option<u32>,
}

#[napi]
pub fn start_tsfn_probe(
    count: u32,
    interval_ms: u32,
    callback: Function<(u32,), ()>,
) -> napi::Result<()> {
    let tsfn: ThreadsafeFunction<u32, (), (u32,), Status, false, false, 1> = callback
        .build_threadsafe_function::<u32>()
        .max_queue_size::<1>()
        .build_callback(|ctx| Ok((ctx.value,)))?;
    RUNTIME.spawn(async move {
        for index in 0..count {
            tokio::time::sleep(Duration::from_millis(interval_ms as u64)).await;
            if tsfn.call(index, ThreadsafeFunctionCallMode::Blocking) != Status::Ok {
                break;
            }
        }
    });
    Ok(())
}

#[napi]
pub fn start_backpressure_probe(
    count: u32,
    callback: Function<(u32, u32), ()>,
) -> napi::Result<()> {
    let tsfn: ThreadsafeFunction<(u32, u32), (), (u32, u32), Status, false, false, 1> = callback
        .build_threadsafe_function::<(u32, u32)>()
        .max_queue_size::<1>()
        .build()?;
    RUNTIME.spawn(async move {
        let started = Instant::now();
        for index in 0..count {
            let rust_at_ms = started.elapsed().as_millis() as u32;
            if tsfn.call((index, rust_at_ms), ThreadsafeFunctionCallMode::Blocking) != Status::Ok {
                break;
            }
        }
    });
    Ok(())
}

#[napi]
pub fn start_request(
    options: StartRequestOptions,
    on_event: Function<(String, u32, u32), ()>,
    on_done: Function<(String, u32), ()>,
) -> napi::Result<u32> {
    let request_id = NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed);
    let cancel = CancellationToken::new();
    REQUESTS
        .lock()
        .map_err(|_| native_error("request registry poisoned"))?
        .insert(request_id, cancel.clone());

    let event_tsfn: ThreadsafeFunction<
        (String, u32, u32),
        (),
        (String, u32, u32),
        Status,
        false,
        false,
        1,
    > = on_event
        .build_threadsafe_function::<(String, u32, u32)>()
        .max_queue_size::<1>()
        .build()?;
    let done_tsfn: ThreadsafeFunction<(String, u32), (), (String, u32), Status, false, false, 1> =
        on_done
            .build_threadsafe_function::<(String, u32)>()
            .max_queue_size::<1>()
            .build()?;
    let client = make_client(options.http2.unwrap_or(false), options.tcp_keepalive_ms)?;
    let url = options.url;

    ACTIVE_TASKS.fetch_add(1, Ordering::SeqCst);
    RUNTIME.spawn(async move {
        let started = Instant::now();
        let outcome: napi::Result<String> = async {
            let response = tokio::select! {
                _ = cancel.cancelled() => return Ok("cancelled-before-headers".to_owned()),
                response = client.get(url).header("x-probe-label", "rust").send() => response.map_err(native_error)?,
            };
            let status = response.status().as_u16() as u32;
            if event_tsfn.call(("headers".to_owned(), status, started.elapsed().as_millis() as u32), ThreadsafeFunctionCallMode::Blocking) != Status::Ok {
                return Err(native_error("TSFN headers callback failed"));
            }
            let mut body = response.bytes_stream();
            let mut chunks = 0_u32;
            loop {
                tokio::select! {
                    _ = cancel.cancelled() => return Ok("cancelled".to_owned()),
                    next = body.next() => match next {
                        Some(Ok(bytes)) => {
                            chunks += 1;
                            if event_tsfn.call((String::from_utf8_lossy(&bytes).into_owned(), chunks, started.elapsed().as_millis() as u32), ThreadsafeFunctionCallMode::Blocking) != Status::Ok {
                                return Err(native_error(format!("TSFN chunk callback failed at chunk {chunks}")));
                            }
                        }
                        Some(Err(error)) => return Err(native_error(error)),
                        None => return Ok(format!("completed:{chunks}")),
                    },
                }
            }
        }
        .await;

        REQUESTS.lock().expect("request registry poisoned").remove(&request_id);
        ACTIVE_TASKS.fetch_sub(1, Ordering::SeqCst);
        let label = match outcome {
            Ok(value) => value,
            Err(error) => format!("error:{error}"),
        };
        let _ = done_tsfn.call(
            (label, started.elapsed().as_millis() as u32),
            ThreadsafeFunctionCallMode::Blocking,
        );
    });

    Ok(request_id)
}

#[napi]
pub fn cancel_request(request_id: u32) -> napi::Result<bool> {
    let token = REQUESTS
        .lock()
        .map_err(|_| native_error("request registry poisoned"))?
        .get(&request_id)
        .cloned();
    if let Some(token) = token {
        token.cancel();
        Ok(true)
    } else {
        Ok(false)
    }
}

#[napi]
pub fn active_task_count() -> u32 {
    ACTIVE_TASKS.load(Ordering::SeqCst)
}

#[napi]
pub fn request_is_registered(request_id: u32) -> napi::Result<bool> {
    Ok(REQUESTS
        .lock()
        .map_err(|_| native_error("request registry poisoned"))?
        .contains_key(&request_id))
}
