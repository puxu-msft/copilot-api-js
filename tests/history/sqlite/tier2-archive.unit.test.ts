/**
 * TIER-2 sealed-unit format v2 (columnar, whole-session, zstd-LDM). Covers the
 * three properties the rewrite depends on:
 *   1. exact round-trip through the sparse-column transpose (incl. an omitted key
 *      and an explicit-null value);
 *   2. the compression LEVER that fixes the 3× bloat — a whole-session single
 *      LDM stream is materially smaller than the old fixed-100-entry chunking when
 *      the redundancy spans more than one chunk;
 *   3. backward read of a pre-upgrade v1 (`sealed_chunk`) unit ("允许从旧版重组").
 */

import {
  //
  describe,
  expect,
  test,
  afterEach,
} from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  //
  zstdCompressSync,
  constants as zlibConstants,
} from "node:zlib"

import type { HistoryEntry } from "~/lib/history/types"

import { createDatabase } from "~/lib/history/sqlite/driver"
import {
  //
  readSealedEntry,
  writeSealUnit,
} from "~/lib/history/sqlite/tier2-archive"

const tmpDirs: Array<string> = []
function mkTmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "tier2-arch-"))
  tmpDirs.push(d)
  return d
}
afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop() as string, { recursive: true, force: true })
})

/** Deterministic high-entropy string (LCG → bytes) so identical copies dedup but a
 *  single copy stays near-incompressible — isolates the cross-chunk duplication cost. */
function pseudoRandom(bytes: number, seed: number): string {
  let s = seed >>> 0
  const out = Array.from<string>({ length: bytes })
  for (let i = 0; i < bytes; i++) {
    s = (s * 1664525 + 1013904223) >>> 0
    out[i] = String.fromCodePoint(33 + (s % 90))
  }
  return out.join("")
}

describe("tier2-archive v2 — columnar + LDM", () => {
  test("round-trips entries exactly, incl. an omitted key and an explicit null", async () => {
    const dir = mkTmp()
    const entries = [
      { id: "e0", model: "m", raw: { a: 1 } },
      { id: "e1", raw: null }, // explicit null value + omits `model`
      { id: "e2", model: "n" }, // omits `raw`
    ] as unknown as Array<HistoryEntry>
    const sealPath = path.join(dir, "archive-0001.db")
    await writeSealUnit(sealPath, entries)

    expect(readSealedEntry(sealPath, 0) as unknown).toEqual({ id: "e0", model: "m", raw: { a: 1 } })
    // omitted `model` stays omitted; explicit null preserved (matches JSON round-trip)
    expect(readSealedEntry(sealPath, 1) as unknown).toEqual({ id: "e1", raw: null })
    expect(readSealedEntry(sealPath, 2) as unknown).toEqual({ id: "e2", model: "n" })
    expect(readSealedEntry(sealPath, 3)).toBeUndefined() // out of range
  })

  test("selective-extract round-trips nested objects, arrays, empty objects & dotted keys", async () => {
    const dir = mkTmp()
    const entries = [
      {
        id: "d0",
        clientRequest: { model: "m", messages: [{ role: "user", content: "hi" }] }, // messages hoisted → own column
        raw: { effectiveSource: { body: { deep: { x: 1 } } }, sse_events: [{ e: 1 }] }, // sse_events hoisted from depth
        "dotted.key": { "a.b": 5 }, // keys containing dots must survive
      },
      { id: "d1", clientRequest: { messages: [] } }, // empty array leaf, rest omitted
    ] as unknown as Array<HistoryEntry>
    const sealPath = path.join(dir, "archive-0002.db")
    await writeSealUnit(sealPath, entries)

    expect(readSealedEntry(sealPath, 0) as unknown).toEqual(entries[0])
    expect(readSealedEntry(sealPath, 1) as unknown).toEqual(entries[1])
  })

  test("whole-session LDM stream is much smaller than old fixed-100-entry chunking", async () => {
    const dir = mkTmp()
    // A 40 KB near-incompressible payload shared by EVERY entry, across 300 entries
    // (= 3 old chunks). Old: each 100-entry chunk pays the payload's first copy once
    // → ~3 copies. New: one whole-session stream → 1 copy. Redundancy spans the session.
    const shared = pseudoRandom(40 * 1024, 12345)
    const entries = Array.from({ length: 300 }, (_, i) => ({ id: `e${i}`, model: "m", raw: { shared, n: i } })) as unknown as Array<HistoryEntry>

    const v2Path = path.join(dir, "archive-0001.db")
    await writeSealUnit(v2Path, entries)
    // Compare COMPRESSED PAYLOAD bytes (sum of column blobs), isolating the fix from
    // fixed SQLite file overhead.
    const v2db = createDatabase(v2Path)
    const v2Bytes = (v2db.prepare("SELECT COALESCE(SUM(LENGTH(blob)), 0) AS n FROM sealed_column").get() as { n: number }).n
    v2db.close()

    // Inline reproduction of the OLD v1 layout: 100-entry JSON chunks, zstd L19,
    // DEFAULT window — the exact code that produced the 3× bloat.
    let v1Bytes = 0
    for (let s = 0; s < entries.length; s += 100) {
      const blob = zstdCompressSync(Buffer.from(JSON.stringify(entries.slice(s, s + 100))), { params: { [zlibConstants.ZSTD_c_compressionLevel]: 19 } })
      v1Bytes += blob.length
    }

    // The lever: the whole-session stream folds the cross-chunk duplication the old
    // per-chunk layout re-pays. Expect a large, unambiguous win (≥2×).
    expect(v2Bytes * 2).toBeLessThan(v1Bytes)
  })

  test("reads a legacy v1 (sealed_chunk) unit when given the session id", () => {
    const dir = mkTmp()
    const sealPath = path.join(dir, "archive-0001.db")
    // Hand-write a v1 unit: chunk_key = `${sessionId}#${chunkIndex}`, blob = zstd of
    // a JSON array of entries (default window). indexInSession 0/1 live in chunk 0.
    const db = createDatabase(sealPath)
    db.exec("CREATE TABLE sealed_chunk (chunk_key TEXT PRIMARY KEY, blob BLOB NOT NULL)")
    const chunk = [
      { id: "old-a", model: "legacy" },
      { id: "old-b", model: "legacy" },
    ]
    const blob = zstdCompressSync(Buffer.from(JSON.stringify(chunk)), { params: { [zlibConstants.ZSTD_c_compressionLevel]: 19 } })
    db.prepare("INSERT INTO sealed_chunk (chunk_key, blob) VALUES (?, ?)").run("sess-legacy#0", new Uint8Array(blob))
    db.close()

    expect(readSealedEntry(sealPath, 0, "sess-legacy")?.id).toBe("old-a")
    expect(readSealedEntry(sealPath, 1, "sess-legacy")?.id).toBe("old-b")
    // v1 read needs the session id to derive the chunk key; without it → undefined
    expect(readSealedEntry(sealPath, 0)).toBeUndefined()
  })
})
