#!/usr/bin/env bun
/**
 * Generate `config.schema.json` from the Zod ConfigSchema.
 *
 * Output is consumed by YAML LSP / VS Code's `yaml.schemas` setting so that
 * `config.yaml` gets live validation + autocomplete in the editor.
 *
 * Usage:
 *   bun run generate:config-schema
 *
 * To wire into VS Code, add to `.vscode/settings.json`:
 *   "yaml.schemas": { "./config.schema.json": "config.yaml" }
 */

import { writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { z } from "zod"

import { ConfigSchema } from "../src/lib/config/schema"

const outPath = resolve(import.meta.dirname, "..", "config.schema.json")

const jsonSchema = z.toJSONSchema(ConfigSchema, {
  target: "draft-2020-12",
  // The schema uses .transform() to map `null` → `undefined` for HTTP PUT
  // semantics. Transforms cannot be expressed in JSON Schema, so emit the
  // INPUT shape (which is what the YAML / API client actually sends).
  io: "input",
  // For any remaining unrepresentable nodes (refinements with no JSON Schema
  // equivalent), emit an open `{}` rather than throwing.
  unrepresentable: "any",
})

// Add metadata so users / editors can identify the schema
const schemaWithMeta = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://github.com/puxu-msft/copilot-api-js/blob/main/config.schema.json",
  title: "copilot-api config.yaml",
  description: "Schema for copilot-api's config.yaml — auto-generated from ConfigSchema (src/lib/config/schema.ts). Do not edit by hand.",
  ...jsonSchema,
}

writeFileSync(outPath, `${JSON.stringify(schemaWithMeta, null, 2)}\n`, "utf8")
console.log(`Wrote JSON Schema → ${outPath}`)
