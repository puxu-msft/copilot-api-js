#!/usr/bin/env bash
set -euo pipefail
export RUSTUP_HOME=/home/xp/.local/rustup
export PATH="$HOME/.cache/cargo/bin:$PATH"
ROOT=/home/xp/src/copilot-api-js/exp/napi-http-spike
mkdir -p "$ROOT/certs"
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$ROOT/certs/key.pem" \
  -out "$ROOT/certs/cert.pem" \
  -subj '/CN=localhost' \
  -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' \
  -days 2 >/dev/null 2>&1
cargo build --release --manifest-path "$ROOT/Cargo.toml"
cp "$ROOT/target/release/libnapi_http_spike.so" "$ROOT/napi_http_spike.node"
