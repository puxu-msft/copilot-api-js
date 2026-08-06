#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cargo build --release --manifest-path "$HERE/Cargo.toml"
cp "$HERE/target/release/libcopilot_http_transport_spike.so" "$HERE/copilot_http_transport_spike.node"
printf 'built %s\n' "$HERE/copilot_http_transport_spike.node"
