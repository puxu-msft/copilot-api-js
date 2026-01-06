// HTML template for history viewer
export const template = `
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

<!-- Raw JSON Modal -->
<div class="modal-overlay" id="raw-modal" onclick="closeRawModal(event)">
  <div class="modal" onclick="event.stopPropagation()">
    <div class="modal-header">
      <span>Raw JSON</span>
      <div>
        <button class="small" onclick="copyRawContent()">Copy</button>
        <button class="icon-only" onclick="closeRawModal()">&times;</button>
      </div>
    </div>
    <div class="modal-body">
      <pre id="raw-content"></pre>
    </div>
  </div>
</div>
`
