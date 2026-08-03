#!/usr/bin/env bash
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cargo build --release --manifest-path "$HERE/Cargo.toml"
cp "$HERE/target/release/libupstream_client_reqwest_spike.so" "$HERE/upstream_client_reqwest_spike.node"
printf 'built %s\n' "$HERE/upstream_client_reqwest_spike.node"
