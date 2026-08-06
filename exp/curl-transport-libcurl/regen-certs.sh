#!/usr/bin/env bash
# The oracles need a self-signed cert. The key is deliberately NOT committed
# (no exp/ dir tracks .pem); regenerate it before a fresh reproduction run.
set -euo pipefail
cd "$(dirname "$0")"
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout test-key.pem -out test-cert.pem \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
chmod 600 test-key.pem
echo "wrote test-key.pem + test-cert.pem"
