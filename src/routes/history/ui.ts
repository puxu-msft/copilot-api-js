// Web UI HTML template for history viewer
// Features: Session grouping, full message content, compact design

import { script } from "./ui/script"
import { styles } from "./ui/styles"
import { template } from "./ui/template"

export function getHistoryUI(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Copilot API - Request History</title>
  <style>${styles}</style>
</head>
<body>
  ${template}
  <script>${script}</script>
</body>
</html>`
}
