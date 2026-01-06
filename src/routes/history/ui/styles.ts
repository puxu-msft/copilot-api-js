// CSS styles for history viewer
export const styles = `
:root {
  --bg: #0d1117;
  --bg-secondary: #161b22;
  --bg-tertiary: #21262d;
  --bg-hover: #30363d;
  --text: #e6edf3;
  --text-muted: #8b949e;
  --text-dim: #6e7681;
  --border: #30363d;
  --primary: #58a6ff;
  --success: #3fb950;
  --error: #f85149;
  --warning: #d29922;
  --purple: #a371f7;
  --cyan: #39c5cf;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #ffffff;
    --bg-secondary: #f6f8fa;
    --bg-tertiary: #eaeef2;
    --bg-hover: #d0d7de;
    --text: #1f2328;
    --text-muted: #656d76;
    --text-dim: #8c959f;
    --border: #d0d7de;
  }
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.4;
  font-size: 13px;
}

/* Layout */
.layout { display: flex; height: 100vh; }
.sidebar {
  width: 280px;
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  background: var(--bg-secondary);
}
.main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }

/* Header */
.header {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  background: var(--bg-secondary);
}
.header h1 { font-size: 16px; font-weight: 600; }
.header-actions { display: flex; gap: 8px; }

/* Stats bar */
.stats-bar {
  display: flex;
  gap: 16px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-tertiary);
  font-size: 12px;
}
.stat { display: flex; align-items: center; gap: 4px; }
.stat-value { font-weight: 600; }
.stat-label { color: var(--text-muted); }

/* Sessions sidebar */
.sidebar-header {
  padding: 12px;
  border-bottom: 1px solid var(--border);
  font-weight: 600;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.sessions-list {
  flex: 1;
  overflow-y: auto;
}
.session-item {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  transition: background 0.15s;
}
.session-item:hover { background: var(--bg-hover); }
.session-item.active { background: var(--bg-tertiary); border-left: 3px solid var(--primary); }
.session-item.all { font-weight: 600; color: var(--primary); }
.session-meta { display: flex; justify-content: space-between; margin-bottom: 4px; }
.session-time { color: var(--text-muted); font-size: 11px; }
.session-stats { display: flex; gap: 8px; font-size: 11px; color: var(--text-dim); }

/* Buttons */
button {
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 5px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  transition: all 0.15s;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
button:hover { background: var(--bg-hover); }
button.primary { background: var(--primary); color: #fff; border-color: var(--primary); }
button.danger { color: var(--error); }
button.danger:hover { background: rgba(248,81,73,0.1); }
button:disabled { opacity: 0.5; cursor: not-allowed; }
button.small { padding: 3px 6px; font-size: 11px; }
button.icon-only { padding: 5px 6px; }

/* Filters */
.filters {
  display: flex;
  gap: 8px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}
input, select {
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 5px 8px;
  border-radius: 6px;
  font-size: 12px;
}
input:focus, select:focus { outline: none; border-color: var(--primary); }
input::placeholder { color: var(--text-dim); }

/* Entries list */
.entries-container { flex: 1; overflow-y: auto; }
.entry-item {
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  transition: background 0.15s;
}
.entry-item:hover { background: var(--bg-secondary); }
.entry-item.selected { background: var(--bg-tertiary); }
.entry-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
}
.entry-time { color: var(--text-muted); font-size: 11px; min-width: 70px; }
.entry-model { font-weight: 500; flex: 1; }
.entry-tokens { font-size: 11px; color: var(--text-dim); }
.entry-duration { font-size: 11px; color: var(--text-dim); min-width: 50px; text-align: right; }

/* Badges */
.badge {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 10px;
  font-size: 10px;
  font-weight: 500;
}
.badge.success { background: rgba(63, 185, 80, 0.15); color: var(--success); }
.badge.error { background: rgba(248, 81, 73, 0.15); color: var(--error); }
.badge.pending { background: rgba(136, 136, 136, 0.15); color: var(--text-muted); }
.badge.anthropic { background: rgba(163, 113, 247, 0.15); color: var(--purple); }
.badge.openai { background: rgba(210, 153, 34, 0.15); color: var(--warning); }
.badge.stream { background: rgba(57, 197, 207, 0.15); color: var(--cyan); }

/* Detail panel */
.detail-panel {
  width: 0;
  border-left: 1px solid var(--border);
  background: var(--bg-secondary);
  transition: width 0.2s;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.detail-panel.open { width: 50%; min-width: 400px; }
.detail-header {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.detail-content { flex: 1; overflow-y: auto; padding: 16px; }
.detail-section { margin-bottom: 16px; }
.detail-section h4 {
  font-size: 11px;
  text-transform: uppercase;
  color: var(--text-muted);
  margin-bottom: 8px;
  letter-spacing: 0.5px;
}

/* Messages display */
.messages-list { display: flex; flex-direction: column; gap: 8px; }
.message {
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--bg);
  border: 1px solid var(--border);
  position: relative;
}
.message.user { border-left: 3px solid var(--primary); }
.message.assistant { border-left: 3px solid var(--success); }
.message.system { border-left: 3px solid var(--warning); background: var(--bg-tertiary); }
.message.tool { border-left: 3px solid var(--purple); }
.message-role {
  font-size: 10px;
  text-transform: uppercase;
  color: var(--text-muted);
  margin-bottom: 4px;
  font-weight: 600;
}
.message-content {
  white-space: pre-wrap;
  word-break: break-word;
  font-family: 'SF Mono', Monaco, 'Courier New', monospace;
  font-size: 12px;
  max-height: 300px;
  overflow-y: auto;
}
.message-content.collapsed { max-height: 100px; }
.expand-btn {
  color: var(--primary);
  cursor: pointer;
  font-size: 11px;
  margin-top: 4px;
  display: inline-block;
}

/* Tool calls */
.tool-call {
  background: var(--bg-tertiary);
  padding: 8px;
  border-radius: 6px;
  margin-top: 8px;
  font-size: 12px;
}
.tool-name { color: var(--purple); font-weight: 600; }
.tool-args {
  font-family: monospace;
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 4px;
  white-space: pre-wrap;
  max-height: 150px;
  overflow-y: auto;
}

/* Response info */
.response-info {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
  gap: 12px;
}
.info-item { }
.info-label { font-size: 11px; color: var(--text-muted); }
.info-value { font-weight: 500; }

/* Empty state */
.empty-state {
  text-align: center;
  padding: 40px 20px;
  color: var(--text-muted);
}
.empty-state h3 { margin-bottom: 8px; color: var(--text); }

/* Loading */
.loading { text-align: center; padding: 20px; color: var(--text-muted); }

/* Scrollbar */
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: var(--bg); }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: var(--text-dim); }

/* Copy/Raw buttons */
.copy-btn, .raw-btn {
  position: absolute;
  top: 4px;
  opacity: 0;
  transition: opacity 0.15s;
}
.copy-btn { right: 4px; }
.raw-btn { right: 50px; }
.message:hover .copy-btn, .message:hover .raw-btn { opacity: 1; }

/* Raw JSON modal */
.modal-overlay {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,0.6);
  display: none;
  justify-content: center;
  align-items: center;
  z-index: 1000;
}
.modal-overlay.open { display: flex; }
.modal {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 8px;
  width: 80%;
  max-width: 800px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
}
.modal-header {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.modal-body {
  flex: 1;
  overflow: auto;
  padding: 16px;
}
.modal-body pre {
  margin: 0;
  font-family: 'SF Mono', Monaco, 'Courier New', monospace;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}
`
