/** MIME type helper for history UI static assets */
export function getMimeType(path: string): string {
  if (path.endsWith(".html")) return "text/html"
  if (path.endsWith(".js")) return "application/javascript"
  if (path.endsWith(".css")) return "text/css"
  if (path.endsWith(".json")) return "application/json"
  if (path.endsWith(".svg")) return "image/svg+xml"
  if (path.endsWith(".png")) return "image/png"
  if (path.endsWith(".ico")) return "image/x-icon"
  return "application/octet-stream"
}
