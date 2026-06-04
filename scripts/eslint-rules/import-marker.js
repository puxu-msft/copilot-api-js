/**
 * Local ESLint rule: multiline-imports
 *
 * Enforces that any `import { a, b, ... } from "x"` with more than one named
 * specifier is broken across multiple lines, with a leading `//` marker on its
 * own line right after the opening brace:
 *
 *     import {
 *       //
 *       a,
 *       b,
 *     } from "x"
 *
 * The marker comment is what makes this survive `prettier --write`: Prettier
 * refuses to fold an object/import body that starts with a leading line comment
 * back onto a single line. Without the marker, Prettier would re-fold short
 * imports whenever `printWidth` is not reached, defeating the rule.
 *
 * This rule is autofixable: it both breaks the import across lines AND inserts
 * the marker in a single pass. We do not depend on `eslint-plugin-import-newlines`
 * because it counts the marker line as an extra specifier and fights us.
 *
 * Single-specifier imports (`import { x } from "y"`) and default-only imports
 * (`import x from "y"`) are left alone.
 */

const rule = {
  meta: {
    type: "layout",
    fixable: "code",
    schema: [],
    messages: {
      mustBeMultiline:
        "Imports with more than one specifier must be broken into multiple lines (with a `//` marker for Prettier).",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode()

    return {
      ImportDeclaration(node) {
        const named = node.specifiers.filter((s) => s.type === "ImportSpecifier")
        if (named.length < 2) return

        const openBrace = sourceCode.getFirstToken(node, (t) => t.type === "Punctuator" && t.value === "{")
        const closeBrace = sourceCode.getLastToken(node, (t) => t.type === "Punctuator" && t.value === "}")
        if (!openBrace || !closeBrace) return

        // What we want, exactly:
        //   - line of `{` ends right after `{`
        //   - next line is `  //`
        //   - each specifier on its own line, comma-terminated
        //   - `}` on its own line
        //
        // Detect violation: either the body is single-line OR the marker is missing.
        const tokenAfterOpen = sourceCode.getTokenAfter(openBrace, {
          includeComments: true,
        })
        const hasMarker =
          tokenAfterOpen
          && tokenAfterOpen.type === "Line"
          && tokenAfterOpen.loc.start.line === openBrace.loc.end.line + 1
          && tokenAfterOpen.value.trim() === ""

        const isMultilineBody = openBrace.loc.end.line !== closeBrace.loc.start.line

        // Check each specifier is on its own line.
        let allOnOwnLines = true
        if (isMultilineBody) {
          let prevLine = (hasMarker ? tokenAfterOpen : openBrace).loc.end.line
          for (const spec of named) {
            if (spec.loc.start.line <= prevLine) {
              allOnOwnLines = false
              break
            }
            prevLine = spec.loc.end.line
          }
        }

        if (isMultilineBody && hasMarker && allOnOwnLines) return

        context.report({
          node,
          messageId: "mustBeMultiline",
          fix(fixer) {
            // Indent: use the indent of the import declaration itself + 2 spaces.
            const lineText = sourceCode.lines[node.loc.start.line - 1] ?? ""
            const baseIndentMatch = /^[\t ]*/.exec(lineText)
            const baseIndent = baseIndentMatch ? baseIndentMatch[0] : ""
            const itemIndent = `${baseIndent}  `

            const specifierTexts = named.map((s) => sourceCode.getText(s))
            const body = `\n${itemIndent}//\n${specifierTexts.map((t) => `${itemIndent}${t},`).join("\n")}\n${baseIndent}`

            return fixer.replaceTextRange([openBrace.range[1], closeBrace.range[0]], body)
          },
        })
      },
    }
  },
}

export default {
  rules: {
    "multiline-imports": rule,
  },
}
