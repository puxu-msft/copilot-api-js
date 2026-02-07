import { describe, expect, test } from "bun:test"

import type { EmbeddingRequest } from "~/services/copilot/create-embeddings"

describe("EmbeddingRequest type", () => {
  test("should accept encoding_format: float", () => {
    const req: EmbeddingRequest = {
      input: "hello",
      model: "text-embedding-3-small",
      encoding_format: "float",
    }
    expect(req.encoding_format).toBe("float")
  })

  test("should accept encoding_format: base64", () => {
    const req: EmbeddingRequest = {
      input: "hello",
      model: "text-embedding-3-small",
      encoding_format: "base64",
    }
    expect(req.encoding_format).toBe("base64")
  })

  test("should accept dimensions", () => {
    const req: EmbeddingRequest = {
      input: "hello",
      model: "text-embedding-3-small",
      dimensions: 256,
    }
    expect(req.dimensions).toBe(256)
  })

  test("should accept array input", () => {
    const req: EmbeddingRequest = {
      input: ["hello", "world"],
      model: "text-embedding-3-small",
    }
    expect(Array.isArray(req.input)).toBe(true)
    expect(req.input).toHaveLength(2)
  })

  test("should work with minimal fields (backward compatible)", () => {
    const req: EmbeddingRequest = {
      input: "hello",
      model: "text-embedding-3-small",
    }
    expect(req.encoding_format).toBeUndefined()
    expect(req.dimensions).toBeUndefined()
  })

  test("should accept all fields together", () => {
    const req: EmbeddingRequest = {
      input: ["hello", "world"],
      model: "text-embedding-3-small",
      encoding_format: "float",
      dimensions: 512,
    }
    expect(req.model).toBe("text-embedding-3-small")
    expect(req.encoding_format).toBe("float")
    expect(req.dimensions).toBe(512)
  })
})
