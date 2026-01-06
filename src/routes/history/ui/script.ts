// JavaScript for history viewer
export const script = `
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
    return content.map(c => {
      if (c.type === 'text') return c.text || '';
      if (c.type === 'tool_use') return '[tool_use: ' + c.name + ']';
      if (c.type === 'tool_result') return '[tool_result: ' + (c.tool_use_id || '').slice(0,8) + ']';
      if (c.type === 'image' || c.type === 'image_url') return '[image]';
      return c.text || '[' + (c.type || 'unknown') + ']';
    }).join('\\n');
  }
  return JSON.stringify(content, null, 2);
}

function formatContentForDisplay(content) {
  if (!content) return { summary: '', raw: 'null' };
  if (typeof content === 'string') return { summary: content, raw: JSON.stringify(content) };
  if (Array.isArray(content)) {
    const parts = [];
    for (const c of content) {
      if (c.type === 'text') {
        parts.push(c.text || '');
      } else if (c.type === 'tool_use') {
        parts.push('--- tool_use: ' + c.name + ' [' + (c.id || '').slice(0,8) + '] ---\\n' + JSON.stringify(c.input, null, 2));
      } else if (c.type === 'tool_result') {
        const resultContent = typeof c.content === 'string' ? c.content : JSON.stringify(c.content, null, 2);
        parts.push('--- tool_result [' + (c.tool_use_id || '').slice(0,8) + '] ---\\n' + resultContent);
      } else if (c.type === 'image' || c.type === 'image_url') {
        parts.push('[image data]');
      } else {
        parts.push(JSON.stringify(c, null, 2));
      }
    }
    return { summary: parts.join('\\n\\n'), raw: JSON.stringify(content, null, 2) };
  }
  const raw = JSON.stringify(content, null, 2);
  return { summary: raw, raw };
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
      const shortId = s.id.slice(0, 8);
      const toolCount = s.toolsUsed ? s.toolsUsed.length : 0;
      html += \`
        <div class="session-item\${isActive ? ' active' : ''}" onclick="selectSession('\${s.id}')">
          <div class="session-meta">
            <span>\${s.models[0] || 'Unknown'}</span>
            <span class="session-time">\${formatDate(s.startTime)}</span>
          </div>
          <div class="session-stats">
            <span style="color:var(--text-dim);font-family:monospace;font-size:10px;">\${shortId}</span>
            <span>\${s.requestCount} req</span>
            <span>\${formatNumber(s.totalInputTokens + s.totalOutputTokens)} tok</span>
            \${toolCount > 0 ? '<span class="badge tool">' + toolCount + ' tools</span>' : ''}
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
      const status = !e.response ? 'pending' : (e.response.success ? 'success' : 'error');
      const statusLabel = !e.response ? 'pending' : (e.response.success ? 'success' : 'error');
      const tokens = e.response ? formatNumber(e.response.usage.input_tokens) + '/' + formatNumber(e.response.usage.output_tokens) : '-';
      const shortId = e.id.slice(0, 8);

      // Get last user message preview
      let lastUserMsg = '';
      for (let i = e.request.messages.length - 1; i >= 0; i--) {
        const msg = e.request.messages[i];
        if (msg.role === 'user') {
          lastUserMsg = getContentText(msg.content).slice(0, 80);
          if (lastUserMsg.length === 80) lastUserMsg += '...';
          break;
        }
      }

      html += \`
        <div class="entry-item\${isSelected ? ' selected' : ''}" onclick="showDetail('\${e.id}')">
          <div class="entry-header">
            <span class="entry-time">\${formatTime(e.timestamp)}</span>
            <span style="color:var(--text-dim);font-family:monospace;font-size:10px;">\${shortId}</span>
            <span class="badge \${e.endpoint}">\${e.endpoint}</span>
            <span class="badge \${status}">\${statusLabel}</span>
            \${e.request.stream ? '<span class="badge stream">stream</span>' : ''}
            <span class="entry-model">\${e.response?.model || e.request.model}</span>
            <span class="entry-tokens">\${tokens}</span>
            <span class="entry-duration">\${formatDuration(e.durationMs)}</span>
          </div>
          \${lastUserMsg ? '<div class="entry-preview">' + escapeHtml(lastUserMsg) + '</div>' : ''}
        </div>
      \`;
    }

    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = '<div class="empty-state">Error: ' + e.message + '</div>';
  }
}

async function showDetail(id) {
  // Update selected state without reloading
  const prevSelected = document.querySelector('.entry-item.selected');
  if (prevSelected) prevSelected.classList.remove('selected');
  const newSelected = document.querySelector(\`.entry-item[onclick*="'\${id}'"]\`);
  if (newSelected) newSelected.classList.add('selected');
  currentEntryId = id;

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

    // Entry metadata (IDs)
    html += \`
      <div class="detail-section">
        <h4>Entry Info</h4>
        <div class="response-info">
          <div class="info-item"><div class="info-label">Entry ID</div><div class="info-value" style="font-family:monospace;font-size:11px;">\${entry.id}</div></div>
          <div class="info-item"><div class="info-label">Session ID</div><div class="info-value" style="font-family:monospace;font-size:11px;">\${entry.sessionId || '-'}</div></div>
          <div class="info-item"><div class="info-label">Timestamp</div><div class="info-value">\${formatDate(entry.timestamp)}</div></div>
          <div class="info-item"><div class="info-label">Endpoint</div><div class="info-value"><span class="badge \${entry.endpoint}">\${entry.endpoint}</span></div></div>
        </div>
      </div>
    \`;

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
      const formatted = formatContentForDisplay(msg.content);
      const isLong = formatted.summary.length > 500;
      const rawContent = JSON.stringify(msg, null, 2);

      html += \`
        <div class="message \${roleClass}">
          <button class="raw-btn small" onclick="showRawJson(event, \${escapeAttr(rawContent)})">Raw</button>
          <button class="copy-btn small" onclick="copyText(event, this)" data-content="\${escapeAttr(formatted.summary)}">Copy</button>
          <div class="message-role">\${msg.role}\${msg.name ? ' (' + msg.name + ')' : ''}\${msg.tool_call_id ? ' [' + (msg.tool_call_id || '').slice(0,8) + ']' : ''}</div>
          <div class="message-content\${isLong ? ' collapsed' : ''}" id="msg-\${Math.random().toString(36).slice(2)}">\${escapeHtml(formatted.summary)}</div>
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
      const formatted = formatContentForDisplay(entry.response.content.content);
      const rawContent = JSON.stringify(entry.response.content, null, 2);
      html += \`
        <div class="detail-section">
          <h4>Response Content</h4>
          <div class="message assistant">
            <button class="raw-btn small" onclick="showRawJson(event, \${escapeAttr(rawContent)})">Raw</button>
            <button class="copy-btn small" onclick="copyText(event, this)" data-content="\${escapeAttr(formatted.summary)}">Copy</button>
            <div class="message-content">\${escapeHtml(formatted.summary)}</div>
          </div>
        </div>
      \`;
    }

    // Response tool calls
    if (entry.response?.toolCalls && entry.response.toolCalls.length > 0) {
      html += '<div class="detail-section"><h4>Tool Calls</h4>';
      for (const tc of entry.response.toolCalls) {
        const tcRaw = JSON.stringify(tc, null, 2);
        html += \`
          <div class="tool-call" style="position:relative;">
            <button class="raw-btn small" style="position:absolute;top:4px;right:4px;opacity:1;" onclick="showRawJson(event, \${escapeAttr(tcRaw)})">Raw</button>
            <span class="tool-name">\${tc.name}</span> <span style="color:var(--text-muted);font-size:11px;">[\${(tc.id || '').slice(0,8)}]</span>
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

let currentRawContent = '';

function showRawJson(event, content) {
  event.stopPropagation();
  currentRawContent = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  document.getElementById('raw-content').textContent = currentRawContent;
  document.getElementById('raw-modal').classList.add('open');
}

function closeRawModal(event) {
  if (event && event.target !== event.currentTarget) return;
  document.getElementById('raw-modal').classList.remove('open');
}

function copyRawContent() {
  navigator.clipboard.writeText(currentRawContent);
  const btns = document.querySelectorAll('.modal-header button');
  const copyBtn = btns[0];
  const orig = copyBtn.textContent;
  copyBtn.textContent = 'Copied!';
  setTimeout(() => copyBtn.textContent = orig, 1000);
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
  if (e.key === 'Escape') {
    if (document.getElementById('raw-modal').classList.contains('open')) {
      closeRawModal();
    } else {
      closeDetail();
    }
  }
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
`
