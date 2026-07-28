// Verify the tests have teeth — show what they catch if the contract is broken.
// We won't actually edit source, just sanity-check the contract assertions.

import { parseDocument, parse } from "yaml"

// Failure mode the strict contract exists to prevent
const dupSrc = "history:\n  limit: 1\n  limit: 999\n"
console.log("parse() (permissive) silently picks last:", parse(dupSrc))
console.log("→ history.limit:", parse(dupSrc).history.limit)
console.log("If loadRawConfigFile was implemented with parse() instead of parseDocument()+strict,")
console.log("`limit: 999` would silently win — exactly the corruption the guard prevents.\n")

// If the implementation forgot to throw on doc.errors:
const doc = parseDocument(dupSrc, { strict: true, uniqueKeys: true })
console.log("doc.errors.length:", doc.errors.length, "→ doc.toJS():", doc.toJS())
console.log("→ doc.toJS() also returns the last value, so dropping the .errors check would silently re-introduce the bug.")
