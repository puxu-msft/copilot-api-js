// Web UI HTML template for history viewer

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
      --text: #c9d1d9;
      --text-muted: #8b949e;
      --border: #30363d;
      --primary: #58a6ff;
      --success: #3fb950;
      --error: #f85149;
      --warning: #d29922;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #ffffff;
        --bg-secondary: #f6f8fa;
        --bg-tertiary: #eaeef2;
        --text: #24292f;
        --text-muted: #57606a;
        --border: #d0d7de;
      }
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
    }
    .container { max-width: 1400px; margin: 0 auto; padding: 20px; }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
      flex-wrap: wrap;
      gap: 10px;
    }
    h1 { font-size: 24px; font-weight: 600; }
    .actions { display: flex; gap: 10px; }
    button {
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 8px 16px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
      transition: background 0.2s;
    }
    button:hover { background: var(--border); }
    button.primary { background: var(--primary); color: #fff; border-color: var(--primary); }
    button.danger { background: var(--error); color: #fff; border-color: var(--error); }

    /* Stats Cards */
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 15px;
      margin-bottom: 20px;
    }
    .stat-card {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 15px;
    }
    .stat-card .value { font-size: 24px; font-weight: 600; }
    .stat-card .label { color: var(--text-muted); font-size: 12px; }

    /* Filters */
    .filters {
      display: flex;
      gap: 10px;
      margin-bottom: 20px;
      flex-wrap: wrap;
    }
    .filters input, .filters select {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 14px;
    }
    .filters input::placeholder { color: var(--text-muted); }
    .filters input:focus, .filters select:focus {
      outline: none;
      border-color: var(--primary);
    }

    /* Table */
    .table-container {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
    }
    table { width: 100%; border-collapse: collapse; }
    th, td {
      padding: 12px;
      text-align: left;
      border-bottom: 1px solid var(--border);
    }
    th { background: var(--bg-tertiary); font-weight: 600; font-size: 12px; }
    tr:hover { background: var(--bg-tertiary); cursor: pointer; }
    tr:last-child td { border-bottom: none; }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 500;
    }
    .badge.success { background: rgba(63, 185, 80, 0.2); color: var(--success); }
    .badge.error { background: rgba(248, 81, 73, 0.2); color: var(--error); }
    .badge.anthropic { background: rgba(88, 166, 255, 0.2); color: var(--primary); }
    .badge.openai { background: rgba(210, 153, 34, 0.2); color: var(--warning); }

    /* Pagination */
    .pagination {
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 10px;
      margin-top: 20px;
    }
    .pagination span { color: var(--text-muted); }

    /* Modal */
    .modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0,0,0,0.7);
      display: none;
      justify-content: center;
      align-items: center;
      z-index: 1000;
    }
    .modal-overlay.active { display: flex; }
    .modal {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 12px;
      width: 90%;
      max-width: 800px;
      max-height: 80vh;
      overflow: auto;
    }
    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px;
      border-bottom: 1px solid var(--border);
    }
    .modal-body { padding: 16px; }
    .modal-close {
      background: none;
      border: none;
      color: var(--text-muted);
      font-size: 24px;
      cursor: pointer;
    }
    pre {
      background: var(--bg-tertiary);
      padding: 12px;
      border-radius: 6px;
      overflow-x: auto;
      font-size: 12px;
      max-height: 300px;
    }
    .detail-section { margin-bottom: 16px; }
    .detail-section h4 { margin-bottom: 8px; color: var(--text-muted); }

    /* Empty State */
    .empty-state {
      text-align: center;
      padding: 60px 20px;
      color: var(--text-muted);
    }
    .empty-state h3 { margin-bottom: 10px; }

    /* Loading */
    .loading { text-align: center; padding: 40px; color: var(--text-muted); }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>📜 Request History</h1>
      <div class="actions">
        <button onclick="refresh()">🔄 Refresh</button>
        <button onclick="exportData('json')">📥 Export JSON</button>
        <button onclick="exportData('csv')">📊 Export CSV</button>
        <button class="danger" onclick="clearAll()">🗑️ Clear All</button>
      </div>
    </header>

    <div class="stats" id="stats">
      <div class="stat-card"><div class="value" id="stat-total">-</div><div class="label">Total Requests</div></div>
      <div class="stat-card"><div class="value" id="stat-success">-</div><div class="label">Successful</div></div>
      <div class="stat-card"><div class="value" id="stat-failed">-</div><div class="label">Failed</div></div>
      <div class="stat-card"><div class="value" id="stat-input">-</div><div class="label">Input Tokens</div></div>
      <div class="stat-card"><div class="value" id="stat-output">-</div><div class="label">Output Tokens</div></div>
      <div class="stat-card"><div class="value" id="stat-avg-duration">-</div><div class="label">Avg Duration</div></div>
    </div>

    <div class="filters">
      <input type="text" id="filter-search" placeholder="🔍 Search content..." onkeyup="debounceSearch()">
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
      <input type="text" id="filter-model" placeholder="Filter by model..." onkeyup="debounceSearch()">
    </div>

    <div class="table-container">
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Endpoint</th>
            <th>Model</th>
            <th>Status</th>
            <th>Tokens</th>
            <th>Duration</th>
          </tr>
        </thead>
        <tbody id="entries-body">
          <tr><td colspan="6" class="loading">Loading...</td></tr>
        </tbody>
      </table>
    </div>

    <div class="pagination" id="pagination"></div>
  </div>

  <div class="modal-overlay" id="modal" onclick="closeModal(event)">
    <div class="modal" onclick="event.stopPropagation()">
      <div class="modal-header">
        <h3>Request Details</h3>
        <button class="modal-close" onclick="closeModal()">&times;</button>
      </div>
      <div class="modal-body" id="modal-body"></div>
    </div>
  </div>

  <script>
    let currentPage = 1;
    const limit = 50;
    let debounceTimer = null;

    function formatDate(ts) {
      return new Date(ts).toLocaleString();
    }

    function formatNumber(n) {
      if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
      if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
      return n.toString();
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
        document.getElementById('stat-avg-duration').textContent = Math.round(data.averageDurationMs) + 'ms';
      } catch (e) {
        console.error('Failed to load stats', e);
      }
    }

    async function loadEntries() {
      const params = new URLSearchParams();
      params.set('page', currentPage);
      params.set('limit', limit);

      const endpoint = document.getElementById('filter-endpoint').value;
      const success = document.getElementById('filter-success').value;
      const search = document.getElementById('filter-search').value;
      const model = document.getElementById('filter-model').value;

      if (endpoint) params.set('endpoint', endpoint);
      if (success) params.set('success', success);
      if (search) params.set('search', search);
      if (model) params.set('model', model);

      const tbody = document.getElementById('entries-body');
      tbody.innerHTML = '<tr><td colspan="6" class="loading">Loading...</td></tr>';

      try {
        const res = await fetch('/history/api/entries?' + params.toString());
        const data = await res.json();

        if (data.error) {
          tbody.innerHTML = '<tr><td colspan="6" class="empty-state"><h3>History Not Enabled</h3><p>Start the server with --history flag</p></td></tr>';
          return;
        }

        if (data.entries.length === 0) {
          tbody.innerHTML = '<tr><td colspan="6" class="empty-state"><h3>No entries found</h3><p>Make some API requests to see history</p></td></tr>';
          document.getElementById('pagination').innerHTML = '';
          return;
        }

        tbody.innerHTML = data.entries.map(e => \`
          <tr onclick="showDetail('\${e.id}')">
            <td>\${formatDate(e.timestamp)}</td>
            <td><span class="badge \${e.endpoint}">\${e.endpoint}</span></td>
            <td>\${e.response?.model || e.request.model}</td>
            <td><span class="badge \${e.response?.success ? 'success' : 'error'}">\${e.response?.success ? 'OK' : 'Error'}</span></td>
            <td>\${e.response ? formatNumber(e.response.usage.input_tokens) + ' / ' + formatNumber(e.response.usage.output_tokens) : '-'}</td>
            <td>\${e.durationMs ? e.durationMs + 'ms' : '-'}</td>
          </tr>
        \`).join('');

        renderPagination(data);
      } catch (e) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-state"><h3>Error</h3><p>' + e.message + '</p></td></tr>';
      }
    }

    function renderPagination(data) {
      const { page, totalPages } = data;
      if (totalPages <= 1) {
        document.getElementById('pagination').innerHTML = '';
        return;
      }
      document.getElementById('pagination').innerHTML = \`
        <button \${page <= 1 ? 'disabled' : ''} onclick="goToPage(\${page - 1})">← Prev</button>
        <span>Page \${page} of \${totalPages}</span>
        <button \${page >= totalPages ? 'disabled' : ''} onclick="goToPage(\${page + 1})">Next →</button>
      \`;
    }

    function goToPage(p) {
      currentPage = p;
      loadEntries();
    }

    function debounceSearch() {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        currentPage = 1;
        loadEntries();
      }, 300);
    }

    async function showDetail(id) {
      try {
        const res = await fetch('/history/api/entries/' + id);
        const entry = await res.json();
        if (entry.error) return;

        document.getElementById('modal-body').innerHTML = \`
          <div class="detail-section">
            <h4>Overview</h4>
            <p><strong>ID:</strong> \${entry.id}</p>
            <p><strong>Time:</strong> \${formatDate(entry.timestamp)}</p>
            <p><strong>Endpoint:</strong> \${entry.endpoint}</p>
            <p><strong>Duration:</strong> \${entry.durationMs || '-'}ms</p>
          </div>
          <div class="detail-section">
            <h4>Request</h4>
            <pre>\${JSON.stringify(entry.request, null, 2)}</pre>
          </div>
          <div class="detail-section">
            <h4>Response</h4>
            <pre>\${JSON.stringify(entry.response, null, 2)}</pre>
          </div>
        \`;
        document.getElementById('modal').classList.add('active');
      } catch (e) {
        console.error('Failed to load entry', e);
      }
    }

    function closeModal(e) {
      if (!e || e.target.classList.contains('modal-overlay')) {
        document.getElementById('modal').classList.remove('active');
      }
    }

    function refresh() {
      loadStats();
      loadEntries();
    }

    function exportData(format) {
      window.open('/history/api/export?format=' + format, '_blank');
    }

    async function clearAll() {
      if (!confirm('Are you sure you want to clear all history?')) return;
      try {
        await fetch('/history/api/entries', { method: 'DELETE' });
        refresh();
      } catch (e) {
        alert('Failed to clear history: ' + e.message);
      }
    }

    // Initial load
    loadStats();
    loadEntries();

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeModal();
    });
  </script>
</body>
</html>`
}
