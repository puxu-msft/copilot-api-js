// Web UI HTML template for history viewer
// Features: Session grouping, full message content, compact design

export function getHistoryUI(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Copilot API - Request History</title>
  <style>
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

    /* Copy button */
    .copy-btn {
      position: absolute;
      top: 4px;
      right: 4px;
      opacity: 0;
      transition: opacity 0.15s;
    }
    .message:hover .copy-btn { opacity: 1; }
    .message { position: relative; }
  </style>
</head>
<body>
  <div class="layout">
    <!-- Sidebar: Sessions -->
    <div class="sidebar">
      <div class="sidebar-header">
        <span>Sessions</span>
        <button class="small danger" onclick="clearAll()" title="Clear all">Clear</button>
      </div>
      <div class="sessions-list" id="sessions-list">
        <div class="loading">Loading...</div>
      </div>
    </div>

    <!-- Main content -->
    <div class="main">
      <div class="header">
        <h1>Request History</h1>
        <div class="header-actions">
          <button onclick="refresh()">Refresh</button>
          <button onclick="exportData('json')">Export JSON</button>
          <button onclick="exportData('csv')">Export CSV</button>
        </div>
      </div>

      <div class="stats-bar" id="stats-bar">
        <div class="stat"><span class="stat-value" id="stat-total">-</span><span class="stat-label">requests</span></div>
        <div class="stat"><span class="stat-value" id="stat-success">-</span><span class="stat-label">success</span></div>
        <div class="stat"><span class="stat-value" id="stat-failed">-</span><span class="stat-label">failed</span></div>
        <div class="stat"><span class="stat-value" id="stat-input">-</span><span class="stat-label">in tokens</span></div>
        <div class="stat"><span class="stat-value" id="stat-output">-</span><span class="stat-label">out tokens</span></div>
        <div class="stat"><span class="stat-value" id="stat-sessions">-</span><span class="stat-label">sessions</span></div>
      </div>

      <div class="filters">
        <input type="text" id="filter-search" placeholder="Search messages..." style="flex:1;min-width:150px" onkeyup="debounceFilter()">
        <select id="filter-endpoint" onchange="loadEntries()">
          <option value="">All Endpoints</option>
          <option value="anthropic">Anthropic</option>
          <option value="openai">OpenAI</option>
        </select>
        <select id="filter-success" onchange="loadEntries()">
          <option value="">All Status</option>
          <option value="true">Success</option>
          <option value="false">Failed</option>
        </select>
      </div>

      <div style="display:flex;flex:1;overflow:hidden;">
        <div class="entries-container" id="entries-container">
          <div class="loading">Loading...</div>
        </div>

        <!-- Detail panel -->
        <div class="detail-panel" id="detail-panel">
          <div class="detail-header">
            <span>Request Details</span>
            <button class="icon-only" onclick="closeDetail()">&times;</button>
          </div>
          <div class="detail-content" id="detail-content"></div>
        </div>
      </div>
    </div>
  </div>

  <script>
    let currentSessionId = null;
    let currentEntryId = null;
    let debounceTimer = null;

    function formatTime(ts) {
      const d = new Date(ts);
      return d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
    }

    function formatDate(ts) {
      const d = new Date(ts);
      return d.toLocaleDateString([], {month:'short',day:'numeric'}) + ' ' + formatTime(ts);
    }

    function formatNumber(n) {
      if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
      if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
      return n.toString();
    }

    function formatDuration(ms) {
      if (!ms) return '-';
      if (ms < 1000) return ms + 'ms';
      return (ms / 1000).toFixed(1) + 's';
    }

    function getContentText(content) {
      if (!content) return '';
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content.map(c => c.text || c.type || '').join('\\n');
      }
      return JSON.stringify(content);
    }

    async function loadStats() {
      try {
        const res = await fetch('/history/api/stats');
        const data = await res.json();
        if (data.error) return;
        document.getElementById('stat-total').textContent = formatNumber(data.totalRequests);
        document.getElementById('stat-success').textContent = formatNumber(data.successfulRequests);
        document.getElementById('stat-failed').textContent = formatNumber(data.failedRequests);
        document.getElementById('stat-input').textContent = formatNumber(data.totalInputTokens);
        document.getElementById('stat-output').textContent = formatNumber(data.totalOutputTokens);
        document.getElementById('stat-sessions').textContent = data.activeSessions;
      } catch (e) {
        console.error('Failed to load stats', e);
      }
    }

    async function loadSessions() {
      try {
        const res = await fetch('/history/api/sessions');
        const data = await res.json();
        if (data.error) {
          document.getElementById('sessions-list').innerHTML = '<div class="empty-state">Not enabled</div>';
          return;
        }

        let html = '<div class="session-item all' + (currentSessionId === null ? ' active' : '') + '" onclick="selectSession(null)">All Requests</div>';

        for (const s of data.sessions) {
          const isActive = currentSessionId === s.id;
          html += \`
            <div class="session-item\${isActive ? ' active' : ''}" onclick="selectSession('\${s.id}')">
              <div class="session-meta">
                <span>\${s.models[0] || 'Unknown'}</span>
                <span class="session-time">\${formatDate(s.startTime)}</span>
              </div>
              <div class="session-stats">
                <span>\${s.requestCount} req</span>
                <span>\${formatNumber(s.totalInputTokens + s.totalOutputTokens)} tok</span>
                <span class="badge \${s.endpoint}">\${s.endpoint}</span>
              </div>
            </div>
          \`;
        }

        document.getElementById('sessions-list').innerHTML = html || '<div class="empty-state">No sessions</div>';
      } catch (e) {
        document.getElementById('sessions-list').innerHTML = '<div class="empty-state">Error loading</div>';
      }
    }

    function selectSession(id) {
      currentSessionId = id;
      loadSessions();
      loadEntries();
      closeDetail();
    }

    async function loadEntries() {
      const container = document.getElementById('entries-container');
      container.innerHTML = '<div class="loading">Loading...</div>';

      const params = new URLSearchParams();
      params.set('limit', '100');

      if (currentSessionId) params.set('sessionId', currentSessionId);

      const endpoint = document.getElementById('filter-endpoint').value;
      const success = document.getElementById('filter-success').value;
      const search = document.getElementById('filter-search').value;

      if (endpoint) params.set('endpoint', endpoint);
      if (success) params.set('success', success);
      if (search) params.set('search', search);

      try {
        const res = await fetch('/history/api/entries?' + params.toString());
        const data = await res.json();

        if (data.error) {
          container.innerHTML = '<div class="empty-state"><h3>History Not Enabled</h3><p>Start server with --history</p></div>';
          return;
        }

        if (data.entries.length === 0) {
          container.innerHTML = '<div class="empty-state"><h3>No entries</h3><p>Make some API requests</p></div>';
          return;
        }

        let html = '';
        for (const e of data.entries) {
          const isSelected = currentEntryId === e.id;
          const status = e.response?.success ? 'success' : 'error';
          const tokens = e.response ? formatNumber(e.response.usage.input_tokens) + '/' + formatNumber(e.response.usage.output_tokens) : '-';

          html += \`
            <div class="entry-item\${isSelected ? ' selected' : ''}" onclick="showDetail('\${e.id}')">
              <div class="entry-header">
                <span class="entry-time">\${formatTime(e.timestamp)}</span>
                <span class="badge \${e.endpoint}">\${e.endpoint}</span>
                <span class="badge \${status}">\${status}</span>
                \${e.request.stream ? '<span class="badge stream">stream</span>' : ''}
                <span class="entry-model">\${e.response?.model || e.request.model}</span>
                <span class="entry-tokens">\${tokens}</span>
                <span class="entry-duration">\${formatDuration(e.durationMs)}</span>
              </div>
            </div>
          \`;
        }

        container.innerHTML = html;
      } catch (e) {
        container.innerHTML = '<div class="empty-state">Error: ' + e.message + '</div>';
      }
    }

    async function showDetail(id) {
      currentEntryId = id;
      loadEntries(); // refresh to show selected state

      const panel = document.getElementById('detail-panel');
      const content = document.getElementById('detail-content');
      panel.classList.add('open');
      content.innerHTML = '<div class="loading">Loading...</div>';

      try {
        const res = await fetch('/history/api/entries/' + id);
        const entry = await res.json();
        if (entry.error) {
          content.innerHTML = '<div class="empty-state">Not found</div>';
          return;
        }

        let html = '';

        // Response info
        if (entry.response) {
          html += \`
            <div class="detail-section">
              <h4>Response</h4>
              <div class="response-info">
                <div class="info-item"><div class="info-label">Status</div><div class="info-value"><span class="badge \${entry.response.success ? 'success' : 'error'}">\${entry.response.success ? 'Success' : 'Error'}</span></div></div>
                <div class="info-item"><div class="info-label">Model</div><div class="info-value">\${entry.response.model}</div></div>
                <div class="info-item"><div class="info-label">Input Tokens</div><div class="info-value">\${formatNumber(entry.response.usage.input_tokens)}</div></div>
                <div class="info-item"><div class="info-label">Output Tokens</div><div class="info-value">\${formatNumber(entry.response.usage.output_tokens)}</div></div>
                <div class="info-item"><div class="info-label">Duration</div><div class="info-value">\${formatDuration(entry.durationMs)}</div></div>
                <div class="info-item"><div class="info-label">Stop Reason</div><div class="info-value">\${entry.response.stop_reason || '-'}</div></div>
              </div>
              \${entry.response.error ? '<div style="color:var(--error);margin-top:8px;">Error: ' + entry.response.error + '</div>' : ''}
            </div>
          \`;
        }

        // System prompt
        if (entry.request.system) {
          html += \`
            <div class="detail-section">
              <h4>System Prompt</h4>
              <div class="message system">
                <div class="message-content">\${escapeHtml(entry.request.system)}</div>
              </div>
            </div>
          \`;
        }

        // Messages
        html += '<div class="detail-section"><h4>Messages</h4><div class="messages-list">';
        for (const msg of entry.request.messages) {
          const roleClass = msg.role === 'user' ? 'user' : (msg.role === 'assistant' ? 'assistant' : (msg.role === 'system' ? 'system' : 'tool'));
          const contentText = getContentText(msg.content);
          const isLong = contentText.length > 500;

          html += \`
            <div class="message \${roleClass}">
              <button class="copy-btn small" onclick="copyText(event, this)" data-content="\${escapeAttr(contentText)}">Copy</button>
              <div class="message-role">\${msg.role}\${msg.name ? ' (' + msg.name + ')' : ''}\${msg.tool_call_id ? ' [' + msg.tool_call_id.slice(0,8) + ']' : ''}</div>
              <div class="message-content\${isLong ? ' collapsed' : ''}" id="msg-\${Math.random().toString(36).slice(2)}">\${escapeHtml(contentText)}</div>
              \${isLong ? '<span class="expand-btn" onclick="toggleExpand(this)">Show more</span>' : ''}
          \`;

          // Tool calls
          if (msg.tool_calls && msg.tool_calls.length > 0) {
            for (const tc of msg.tool_calls) {
              html += \`
                <div class="tool-call">
                  <span class="tool-name">\${tc.function.name}</span>
                  <div class="tool-args">\${escapeHtml(tc.function.arguments)}</div>
                </div>
              \`;
            }
          }

          html += '</div>';
        }
        html += '</div></div>';

        // Response content
        if (entry.response?.content) {
          const respText = getContentText(entry.response.content.content);
          html += \`
            <div class="detail-section">
              <h4>Response Content</h4>
              <div class="message assistant">
                <button class="copy-btn small" onclick="copyText(event, this)" data-content="\${escapeAttr(respText)}">Copy</button>
                <div class="message-content">\${escapeHtml(respText)}</div>
              </div>
            </div>
          \`;
        }

        // Response tool calls
        if (entry.response?.toolCalls && entry.response.toolCalls.length > 0) {
          html += '<div class="detail-section"><h4>Tool Calls</h4>';
          for (const tc of entry.response.toolCalls) {
            html += \`
              <div class="tool-call">
                <span class="tool-name">\${tc.name}</span>
                <div class="tool-args">\${escapeHtml(tc.input)}</div>
              </div>
            \`;
          }
          html += '</div>';
        }

        // Tools defined
        if (entry.request.tools && entry.request.tools.length > 0) {
          html += '<div class="detail-section"><h4>Available Tools (' + entry.request.tools.length + ')</h4>';
          html += '<div style="font-size:11px;color:var(--text-muted)">' + entry.request.tools.map(t => t.name).join(', ') + '</div>';
          html += '</div>';
        }

        content.innerHTML = html;
      } catch (e) {
        content.innerHTML = '<div class="empty-state">Error: ' + e.message + '</div>';
      }
    }

    function closeDetail() {
      currentEntryId = null;
      document.getElementById('detail-panel').classList.remove('open');
      loadEntries();
    }

    function toggleExpand(btn) {
      const content = btn.previousElementSibling;
      const isCollapsed = content.classList.contains('collapsed');
      content.classList.toggle('collapsed');
      btn.textContent = isCollapsed ? 'Show less' : 'Show more';
    }

    function copyText(event, btn) {
      event.stopPropagation();
      const text = btn.getAttribute('data-content');
      navigator.clipboard.writeText(text);
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = orig, 1000);
    }

    function escapeHtml(str) {
      if (!str) return '';
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function escapeAttr(str) {
      if (!str) return '';
      return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function debounceFilter() {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(loadEntries, 300);
    }

    function refresh() {
      loadStats();
      loadSessions();
      loadEntries();
    }

    function exportData(format) {
      window.open('/history/api/export?format=' + format, '_blank');
    }

    async function clearAll() {
      if (!confirm('Clear all history? This cannot be undone.')) return;
      try {
        await fetch('/history/api/entries', { method: 'DELETE' });
        currentSessionId = null;
        currentEntryId = null;
        closeDetail();
        refresh();
      } catch (e) {
        alert('Failed: ' + e.message);
      }
    }

    // Initial load
    loadStats();
    loadSessions();
    loadEntries();

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeDetail();
      if (e.key === 'r' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        refresh();
      }
    });

    // Auto-refresh every 10 seconds
    setInterval(() => {
      loadStats();
      loadSessions();
    }, 10000);
  </script>
</body>
</html>`
}
