// State
let currentSessionId = null
let currentEntryId = null
let currentEntry = null
let currentPage = 1
let totalPages = 1
let listSearchTimer = null
let detailSearchTimer = null
let detailSearchQuery = ""

// SVG icons (Ionicons5 style, consistent with v2)
const ICON_EXPAND =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="none" stroke="currentColor" stroke-width="32" stroke-linecap="round" stroke-linejoin="round"><polyline points="432 368 432 432 368 432"/><line x1="432" y1="432" x2="336" y2="336"/><polyline points="80 144 80 80 144 80"/><line x1="80" y1="80" x2="176" y2="176"/><polyline points="368 80 432 80 432 144"/><line x1="432" y1="80" x2="336" y2="176"/><polyline points="144 432 80 432 80 368"/><line x1="80" y1="432" x2="176" y2="336"/></svg>'
const ICON_CONTRACT =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="none" stroke="currentColor" stroke-width="32" stroke-linecap="round" stroke-linejoin="round"><polyline points="336 368 336 432 400 432"/><line x1="336" y1="432" x2="432" y2="336"/><polyline points="176 144 176 80 112 80"/><line x1="176" y1="80" x2="80" y2="176"/><polyline points="400 80 336 80 336 144"/><line x1="336" y1="80" x2="432" y2="176"/><polyline points="112 432 176 432 176 368"/><line x1="176" y1="432" x2="80" y2="336"/></svg>'
// Copy - Ionicons CopyOutline
const ICON_COPY =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="none" stroke="currentColor" stroke-width="32" stroke-linejoin="round"><rect x="128" y="128" width="336" height="336" rx="57" ry="57"/><path d="M383.5 128l.5-24a56.16 56.16 0 00-56-56H112a64.19 64.19 0 00-64 64v216a56.16 56.16 0 0056 56h24" stroke-linecap="round"/></svg>'
// Code view - Ionicons CodeSlashOutline
const ICON_CODE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="none" stroke="currentColor" stroke-width="32" stroke-linecap="round" stroke-linejoin="round"><path d="M160 368L32 256l128-112"/><path d="M352 368l128-112-128-112"/><path d="M304 96l-96 320"/></svg>'
// Close - Ionicons CloseOutline
const ICON_CLOSE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="none" stroke="currentColor" stroke-width="32" stroke-linecap="round" stroke-linejoin="round"><path d="M368 368L144 144"/><path d="M368 144L144 368"/></svg>'
// Search - Ionicons SearchOutline
const ICON_SEARCH =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="none" stroke="currentColor" stroke-width="32" stroke-linecap="round" stroke-linejoin="round"><path d="M221.09 64a157.09 157.09 0 10157.09 157.09A157.1 157.1 0 00221.09 64z"/><path d="M338.29 338.29L448 448"/></svg>'
// Refresh - Ionicons RefreshOutline
const ICON_REFRESH =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="none" stroke="currentColor" stroke-width="32" stroke-linecap="round" stroke-linejoin="round"><path d="M320 146s24.36-12-64-12a160 160 0 10160 160" /><polyline points="256 58 336 138 256 218"/></svg>'
// Download - Ionicons DownloadOutline
const ICON_DOWNLOAD =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="none" stroke="currentColor" stroke-width="32" stroke-linecap="round" stroke-linejoin="round"><path d="M336 176h40a40 40 0 0140 40v208a40 40 0 01-40 40H136a40 40 0 01-40-40V216a40 40 0 0140-40h40"/><polyline points="176 272 256 352 336 272"/><line x1="256" y1="48" x2="256" y2="336"/></svg>'
// Trash - Ionicons TrashOutline
const ICON_TRASH =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="none" stroke="currentColor" stroke-width="32" stroke-linecap="round" stroke-linejoin="round"><path d="M112 112l20 320c.95 18.49 14.4 32 32 32h184c17.67 0 30.87-13.51 32-32l20-320"/><line x1="80" y1="112" x2="432" y2="112"/><path d="M192 112V72h0a23.93 23.93 0 0124-24h80a23.93 23.93 0 0124 24h0v40" stroke-linecap="round"/></svg>'

// Collapse state for sections
let sectionCollapseState = { meta: false, request: false, response: false }

// Raw data registry - stores data for showRaw to avoid inline JSON in onclick
let rawDataRegistry = []
function registerRawData(data) {
  const index = rawDataRegistry.length
  rawDataRegistry.push(data)
  return index
}

// Formatting utilities
function formatTime(ts) {
  const d = new Date(ts)
  const h = String(d.getHours()).padStart(2, "0")
  const m = String(d.getMinutes()).padStart(2, "0")
  const s = String(d.getSeconds()).padStart(2, "0")
  return h + ":" + m + ":" + s
}

function formatDate(ts) {
  const d = new Date(ts)
  const today = new Date()
  if (d.toDateString() === today.toDateString()) {
    return formatTime(ts)
  }
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return y + "-" + mo + "-" + day + " " + formatTime(ts)
}

function formatNumber(n) {
  if (n === undefined || n === null) return "-"
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M"
  if (n >= 1000) return (n / 1000).toFixed(1) + "K"
  return n.toString()
}

function formatDuration(ms) {
  if (!ms) return "-"
  if (ms < 1000) return ms + "ms"
  return (ms / 1000).toFixed(1) + "s"
}

function escapeHtml(text) {
  if (!text) return ""
  const div = document.createElement("div")
  div.textContent = text
  return div.innerHTML
}

// JSON Tree view builder (pure JS, no external deps)
function buildJsonTree(data, depth) {
  if (depth === undefined) depth = 3
  const container = document.createElement("div")
  container.className = "json-tree"
  const ul = document.createElement("ul")
  buildNode(ul, null, data, depth, 0, false)
  container.append(ul)
  return container
}

function buildNode(parent, key, value, maxDepth, currentDepth, isLast) {
  const li = document.createElement("li")

  if (value !== null && typeof value === "object") {
    const isArray = Array.isArray(value)
    const entries = isArray ? value : Object.entries(value)
    const len = isArray ? value.length : Object.keys(value).length
    const openBracket = isArray ? "[" : "{"
    const closeBracket = isArray ? "]" : "}"

    const toggle = document.createElement("span")
    toggle.className = "jt-toggle"
    toggle.textContent = currentDepth < maxDepth ? "\u25BE" : "\u25B8"
    li.append(toggle)

    if (key !== null) {
      const keySpan = document.createElement("span")
      keySpan.className = "jt-key"
      keySpan.textContent = '"' + key + '"'
      li.append(keySpan)
      li.append(document.createTextNode(": "))
    }

    const bracket = document.createElement("span")
    bracket.className = "jt-bracket"
    bracket.textContent = openBracket
    li.append(bracket)

    // Collapsed info
    const collapsedInfo = document.createElement("span")
    collapsedInfo.className = "jt-collapsed-info"
    collapsedInfo.textContent = " " + len + (len === 1 ? " item" : " items") + " "
    collapsedInfo.style.display = currentDepth < maxDepth ? "none" : "inline"
    li.append(collapsedInfo)

    // Children
    const childUl = document.createElement("ul")
    childUl.style.display = currentDepth < maxDepth ? "block" : "none"

    if (isArray) {
      for (let i = 0; i < value.length; i++) {
        buildNode(childUl, null, value[i], maxDepth, currentDepth + 1, i === value.length - 1)
      }
    } else {
      const keys = Object.keys(value)
      for (let i = 0; i < keys.length; i++) {
        buildNode(childUl, keys[i], value[keys[i]], maxDepth, currentDepth + 1, i === keys.length - 1)
      }
    }
    li.append(childUl)

    // Close bracket
    const closeBr = document.createElement("span")
    closeBr.className = "jt-bracket"
    closeBr.textContent = closeBracket
    li.append(closeBr)

    if (!isLast) {
      const comma = document.createElement("span")
      comma.className = "jt-comma"
      comma.textContent = ","
      li.append(comma)
    }

    // Toggle handler
    toggle.addEventListener("click", function () {
      const isOpen = childUl.style.display !== "none"
      childUl.style.display = isOpen ? "none" : "block"
      collapsedInfo.style.display = isOpen ? "inline" : "none"
      toggle.textContent = isOpen ? "\u25B8" : "\u25BE"
    })
  } else {
    // Leaf: spacer for alignment
    const spacer = document.createElement("span")
    spacer.style.display = "inline-block"
    spacer.style.width = "14px"
    spacer.style.marginRight = "2px"
    li.append(spacer)

    if (key !== null) {
      const keySpan = document.createElement("span")
      keySpan.className = "jt-key"
      keySpan.textContent = '"' + key + '"'
      li.append(keySpan)
      li.append(document.createTextNode(": "))
    }

    const valSpan = document.createElement("span")
    if (value === null) {
      valSpan.className = "jt-null"
      valSpan.textContent = "null"
    } else if (typeof value === "string") {
      valSpan.className = "jt-string"
      if (value.length > 300) {
        // Long string: show truncated with expand toggle
        const previewText = value.slice(0, 300)
        valSpan.textContent = '"' + previewText + '..."'
        valSpan.classList.add("jt-string-truncated")

        const expandBtn = document.createElement("span")
        expandBtn.className = "jt-expand-string"
        expandBtn.textContent = "(" + value.length.toLocaleString() + " chars - click to expand)"
        let expanded = false
        expandBtn.addEventListener("click", function (e) {
          e.stopPropagation()
          expanded = !expanded
          if (expanded) {
            valSpan.textContent = '"' + value + '"'
            expandBtn.textContent = "(click to collapse)"
          } else {
            valSpan.textContent = '"' + previewText + '..."'
            expandBtn.textContent = "(" + value.length.toLocaleString() + " chars - click to expand)"
          }
        })
        li.append(valSpan)
        li.append(expandBtn)
        if (!isLast) {
          const comma = document.createElement("span")
          comma.className = "jt-comma"
          comma.textContent = ","
          li.append(comma)
        }
        parent.append(li)
        return // Early return since we handled appending
      }
      valSpan.textContent = '"' + value + '"'
    } else if (typeof value === "number") {
      valSpan.className = "jt-number"
      valSpan.textContent = String(value)
    } else if (typeof value === "boolean") {
      valSpan.className = "jt-boolean"
      valSpan.textContent = String(value)
    } else {
      valSpan.textContent = String(value)
    }
    li.append(valSpan)

    if (!isLast) {
      const comma = document.createElement("span")
      comma.className = "jt-comma"
      comma.textContent = ","
      li.append(comma)
    }
  }

  parent.append(li)
}

function highlightSearch(text, query) {
  if (!query || !text) return escapeHtml(text)
  const escaped = escapeHtml(text)
  const regex = new RegExp("(" + query.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`) + ")", "gi")
  return escaped.replace(regex, '<span class="search-highlight">$1</span>')
}

// Get preview text from messages
function getPreviewText(request) {
  if (!request || !request.request) return ""
  const messages = request.request.messages || []
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === "user") {
      const content = msg.content
      if (typeof content === "string") {
        return content.replaceAll(/<[^>]+>/g, "").slice(0, 100)
      }
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && block.text) {
            return block.text.replaceAll(/<[^>]+>/g, "").slice(0, 100)
          }
          if (block.type === "tool_result") {
            return "[tool_result: " + (block.tool_use_id || "").slice(0, 8) + "]"
          }
        }
      }
    }
  }
  return ""
}

function getMessageSummary(content) {
  if (typeof content === "string") {
    return content.length > 80 ? content.slice(0, 80) + "..." : content
  }
  if (Array.isArray(content)) {
    if (content.length === 1 && content[0].type === "text") {
      const text = content[0].text || ""
      return text.length > 80 ? text.slice(0, 80) + "..." : text
    }
    const counts = {}
    for (const b of content) {
      counts[b.type] = (counts[b.type] || 0) + 1
    }
    return Object.entries(counts)
      .map(function (e) {
        return e[1] + " " + e[0]
      })
      .join(", ")
  }
  return ""
}

function getContentBlockSummary(block) {
  if (block.type === "text") {
    const text = block.text || ""
    return text.length > 60 ? text.slice(0, 60) + "..." : text
  }
  if (block.type === "thinking") {
    const text = block.thinking || ""
    return text.length > 60 ? text.slice(0, 60) + "..." : text
  }
  if (block.type === "tool_use") return block.name || ""
  if (block.type === "tool_result") return "for " + (block.tool_use_id || "")
  return block.type
}

// Load sessions for dropdown
async function loadSessions() {
  try {
    const response = await fetch("/history/api/sessions")
    const data = await response.json()
    const select = document.querySelector("#session-select")
    select.innerHTML = '<option value="">All Sessions</option>'
    for (const session of data.sessions || []) {
      const opt = document.createElement("option")
      opt.value = session.id
      const time = formatDate(session.startTime)
      opt.textContent = time + " (" + session.requestCount + " reqs)"
      select.append(opt)
    }
  } catch (e) {
    console.error("Failed to load sessions:", e)
  }
}

// Load stats
async function loadStats() {
  try {
    const response = await fetch("/history/api/stats")
    const stats = await response.json()
    document.querySelector("#stat-total").textContent = formatNumber(stats.totalRequests)
    document.querySelector("#stat-success").textContent = formatNumber(stats.successfulRequests)
    document.querySelector("#stat-failed").textContent = formatNumber(stats.failedRequests)
    document.querySelector("#stat-input").textContent = formatNumber(stats.totalInputTokens)
    document.querySelector("#stat-output").textContent = formatNumber(stats.totalOutputTokens)
  } catch (e) {
    console.error("Failed to load stats:", e)
  }
}

// Load entries
async function loadEntries() {
  const listEl = document.querySelector("#request-list")
  const search = document.querySelector("#list-search").value
  const endpoint = document.querySelector("#filter-endpoint").value
  const success = document.querySelector("#filter-status").value

  const params = new URLSearchParams()
  params.set("page", currentPage)
  params.set("limit", 20)
  if (currentSessionId) params.set("sessionId", currentSessionId)
  if (search) params.set("search", search)
  if (endpoint) params.set("endpoint", endpoint)
  if (success) params.set("success", success)

  try {
    const response = await fetch("/history/api/entries?" + params.toString())
    const data = await response.json()
    totalPages = data.totalPages || 1

    if (!data.entries || data.entries.length === 0) {
      listEl.innerHTML = '<div class="empty-state"><h3>No requests found</h3><p>Try adjusting your filters</p></div>'
      updateSearchCount(0, search)
      renderPagination()
      return
    }

    updateSearchCount(data.total, search)

    let html = ""
    for (const entry of data.entries) {
      const isSelected = entry.id === currentEntryId
      const statusClass =
        !entry.response ? "pending"
        : entry.response.success !== false ? "success"
        : "error"
      const model = entry.response?.model || entry.request?.model || "unknown"
      const endpoint = entry.endpoint || "unknown"
      const inputTokens = entry.response?.usage?.input_tokens
      const outputTokens = entry.response?.usage?.output_tokens
      const preview = getPreviewText(entry)
      const isStream = entry.request?.stream

      html +=
        '<div class="request-item'
        + (isSelected ? " selected" : "")
        + '" data-id="'
        + entry.id
        + '" onclick="selectEntry(\''
        + entry.id
        + "')\">"
      html += '<div class="request-item-header">'
      html += '<span class="request-status ' + statusClass + '"></span>'
      html += '<span class="request-time">' + formatDate(entry.timestamp) + "</span>"
      html += "</div>"
      html += '<div class="request-item-body">'
      html += '<span class="request-model">' + escapeHtml(model) + "</span>"
      html += '<span class="badge ' + endpoint + '">' + endpoint + "</span>"
      if (isStream) html += '<span class="badge stream">stream</span>'
      html += "</div>"
      html += '<div class="request-item-meta">'
      html += "<span>\u2193" + formatNumber(inputTokens) + "</span>"
      html += "<span>\u2191" + formatNumber(outputTokens) + "</span>"
      html += "<span>" + formatDuration(entry.durationMs) + "</span>"
      html += "</div>"
      if (preview) {
        html += '<div class="request-preview">' + escapeHtml(preview) + "</div>"
      }
      html += "</div>"
    }

    listEl.innerHTML = html
    renderPagination()

    // Auto-select the first (newest) entry if nothing is selected
    if (!currentEntryId && data.entries.length > 0) {
      selectEntry(data.entries[0].id)
    }
  } catch (e) {
    console.error("Failed to load entries:", e)
    listEl.innerHTML =
      '<div class="empty-state"><h3>Error loading requests</h3><p>' + escapeHtml(e.message) + "</p></div>"
  }
}

function updateSearchCount(total, search) {
  let countEl = document.querySelector("#search-count")
  if (!countEl) {
    const searchInput = document.querySelector("#list-search")
    countEl = document.createElement("span")
    countEl.id = "search-count"
    countEl.style.cssText = "font-size:11px;color:var(--text-secondary);margin-left:8px;"
    searchInput.parentElement.append(countEl)
  }
  countEl.textContent = search ? `${total} hit${total !== 1 ? "s" : ""}` : ""
}

function renderPagination() {
  const el = document.querySelector("#list-pagination")
  if (totalPages <= 1) {
    el.innerHTML = ""
    return
  }

  let html = ""
  html +=
    "<button " + (currentPage <= 1 ? "disabled" : "") + ' onclick="goToPage(' + (currentPage - 1) + ')">\u25C0</button>'

  const maxVisible = 5
  let startPage = Math.max(1, currentPage - Math.floor(maxVisible / 2))
  let endPage = Math.min(totalPages, startPage + maxVisible - 1)
  if (endPage - startPage < maxVisible - 1) {
    startPage = Math.max(1, endPage - maxVisible + 1)
  }

  if (startPage > 1) {
    html += '<button onclick="goToPage(1)">1</button>'
    if (startPage > 2) html += "<span>...</span>"
  }

  for (let i = startPage; i <= endPage; i++) {
    html +=
      '<button class="' + (i === currentPage ? "active" : "") + '" onclick="goToPage(' + i + ')">' + i + "</button>"
  }

  if (endPage < totalPages) {
    if (endPage < totalPages - 1) html += "<span>...</span>"
    html += '<button onclick="goToPage(' + totalPages + ')">' + totalPages + "</button>"
  }

  html +=
    "<button "
    + (currentPage >= totalPages ? "disabled" : "")
    + ' onclick="goToPage('
    + (currentPage + 1)
    + ')">\u25B6</button>'
  el.innerHTML = html
}

function goToPage(page) {
  currentPage = page
  loadEntries()
}

// Select entry
async function selectEntry(id) {
  currentEntryId = id

  // Update selection UI
  for (const el of document.querySelectorAll(".request-item")) {
    el.classList.toggle("selected", el.dataset.id === id)
  }

  try {
    const response = await fetch("/history/api/entries/" + id)
    currentEntry = await response.json()
    sectionCollapseState = { meta: false, request: false, response: false }
    showDetailView()
    renderDetail()
    // Scroll detail panel to bottom so the latest messages/response are visible
    const detailContent = document.querySelector("#detail-content")
    if (detailContent) detailContent.scrollTop = detailContent.scrollHeight
  } catch (e) {
    console.error("Failed to load entry:", e)
  }
}

function showDetailView() {
  document.querySelector("#detail-empty").style.display = "none"
  const detailView = document.querySelector("#detail-view")
  detailView.style.display = "flex"
}

function hideDetailView() {
  document.querySelector("#detail-empty").style.display = "flex"
  document.querySelector("#detail-view").style.display = "none"
  currentEntry = null
  currentEntryId = null
}

// Toggle a section collapse
function toggleSection(section) {
  sectionCollapseState[section] = !sectionCollapseState[section]
  renderDetail()
}

// Toggle message collapse
function toggleMessage(msgId) {
  const block = document.getElementById(msgId)
  if (!block) return
  const bodies = block.querySelectorAll(".message-body")
  const summary = block.querySelector(".collapsed-summary")
  const icon = block.querySelector(".collapse-icon")
  // Check if currently collapsed (first body hidden)
  const isCollapsed = bodies.length > 0 && bodies[0].dataset.collapsed === "true"
  if (isCollapsed) {
    for (const b of bodies) {
      // Restore previous display state (only the active view should be visible)
      b.style.display = b.dataset.prevDisplay || ""
      delete b.dataset.collapsed
      delete b.dataset.prevDisplay
    }
    if (summary) summary.style.display = "none"
    if (icon) icon.textContent = "\u25BE"
  } else {
    for (const b of bodies) {
      b.dataset.prevDisplay = b.style.display
      b.dataset.collapsed = "true"
      b.style.display = "none"
    }
    if (summary) summary.style.display = ""
    if (icon) icon.textContent = "\u25B8"
  }
}

// Toggle content block collapse
function toggleContentBlock(blockId) {
  const block = document.getElementById(blockId)
  if (!block) return
  const body = block.querySelector(".content-block-body")
  const summary = block.querySelector(".collapsed-summary")
  const icon = block.querySelector(".collapse-icon")
  if (body.style.display === "none") {
    body.style.display = ""
    if (summary) summary.style.display = "none"
    if (icon) icon.textContent = "\u25BE"
  } else {
    body.style.display = "none"
    if (summary) summary.style.display = ""
    if (icon) icon.textContent = "\u25B8"
  }
}

// Render detail view
function renderDetail() {
  if (!currentEntry) return

  // Clear raw data registry and reset ID counters for fresh render
  rawDataRegistry = []
  msgIdCounter = 0
  blockIdCounter = 0

  const content = document.querySelector("#detail-content")
  const filterRole = document.querySelector("#filter-role").value
  const filterType = document.querySelector("#filter-type").value
  const aggregateTools = document.querySelector("#toggle-aggregate").checked
  const rewrites = currentEntry.pipelineInfo
  const truncation = rewrites?.truncation

  // Build tool result map for aggregation
  const toolResultMap = {}
  // Build tool_use_id → tool name map for tool_result headers
  const toolUseNameMap = {}
  if (aggregateTools) {
    const messages = currentEntry.request?.messages || []
    for (const msg of messages) {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "tool_result" && block.tool_use_id) {
            toolResultMap[block.tool_use_id] = block
          }
          if (block.type === "tool_use" && block.id) {
            toolUseNameMap[block.id] = block.name || ""
          }
        }
      }
    }
  } else {
    const messages = currentEntry.request?.messages || []
    for (const msg of messages) {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "tool_use" && block.id) {
            toolUseNameMap[block.id] = block.name || ""
          }
        }
      }
    }
  }

  let html = '<div class="conversation">'

  // REQUEST section
  const fullEntryRawIdx = registerRawData(currentEntry)
  const reqIcon = sectionCollapseState.request ? "\u25B8" : "\u25BE"
  const msgCount = (currentEntry.request?.messages || []).length
  const reqRawIdx = registerRawData(currentEntry.request)
  html += '<div class="section-block">'
  html += '<div class="section-header">'
  html += '<div class="section-header-left" onclick="toggleSection(\'request\')">'
  html += '<span class="collapse-icon">' + reqIcon + "</span>"
  html += "REQUEST"
  html += '<span class="section-badge">' + msgCount + " messages</span>"
  html += "</div>"
  html += '<div class="section-header-actions">'
  html +=
    '<button class="action-btn" onclick="event.stopPropagation();showRaw(\'Request\', '
    + reqRawIdx
    + ')" title="View Raw">'
    + ICON_CODE
    + "Raw</button>"
  html += "</div>"
  html += "</div>"

  if (!sectionCollapseState.request) {
    html += '<div class="section-body">'

    // System message
    const system = currentEntry.request?.system
    const rewrittenSystem = rewrites?.rewrittenSystem
    if (system && (!filterRole || filterRole === "system")) {
      html += renderSystemMessage(system, rewrittenSystem)
    }

    // Messages
    const messages = currentEntry.request?.messages || []
    const rewrittenMessages = rewrites?.rewrittenMessages
    const messageMapping = rewrites?.messageMapping
    const removedCount = truncation ? truncation.removedMessageCount : 0

    // Build reverse lookup: origIdx → rwIdx (first occurrence)
    var origToRwIdx = {}
    if (messageMapping && Array.isArray(messageMapping)) {
      for (var [mi, oi] of messageMapping.entries()) {
        if (oi >= 0 && !(oi in origToRwIdx)) {
          origToRwIdx[oi] = mi
        }
      }
    }

    for (const [i, msg] of messages.entries()) {
      if (filterRole && msg.role !== filterRole) continue
      const isTruncated = i < removedCount

      // Find corresponding rewritten message via mapping
      let rewrittenMsg = null
      if (!isTruncated && rewrittenMessages) {
        if (messageMapping && i in origToRwIdx) {
          rewrittenMsg = rewrittenMessages[origToRwIdx[i]]
        } else if (!messageMapping) {
          // Fallback for old data without mapping: use offset
          const rwIdx = i - removedCount
          if (rwIdx >= 0 && rwIdx < rewrittenMessages.length) {
            rewrittenMsg = rewrittenMessages[rwIdx]
          }
        }
      }

      // Determine if content was actually rewritten by comparing text
      const isRewritten = rewrittenMsg != null && !messagesContentEqual(msg, rewrittenMsg)

      html += renderMessage(
        msg,
        filterType,
        aggregateTools,
        toolResultMap,
        toolUseNameMap,
        isTruncated,
        isRewritten,
        rewrittenMsg,
      )
      // Insert truncation divider after the last removed message
      if (isTruncated && i === removedCount - 1) {
        const pct = Math.round((1 - truncation.compactedTokens / truncation.originalTokens) * 100)
        html += '<div class="truncation-divider">'
        html += '<span class="truncation-divider-line"></span>'
        html +=
          '<span class="truncation-divider-label">'
          + removedCount
          + " messages truncated ("
          + formatNumber(truncation.originalTokens)
          + " \u2192 "
          + formatNumber(truncation.compactedTokens)
          + " tokens, -"
          + pct
          + "%)</span>"
        html += '<span class="truncation-divider-line"></span>'
        html += "</div>"
      }
    }

    html += "</div>"
  }
  html += "</div>"

  // RESPONSE section
  const resIcon = sectionCollapseState.response ? "\u25B8" : "\u25BE"
  const resRawIdx = registerRawData(currentEntry.response)
  html += '<div class="section-block">'
  html += '<div class="section-header">'
  html += '<div class="section-header-left" onclick="toggleSection(\'response\')">'
  html += '<span class="collapse-icon">' + resIcon + "</span>"
  html += "RESPONSE"
  html += "</div>"
  html += '<div class="section-header-actions">'
  html +=
    '<button class="action-btn" onclick="event.stopPropagation();showRaw(\'Response\', '
    + resRawIdx
    + ')" title="View Raw">'
    + ICON_CODE
    + "Raw</button>"
  html += "</div>"
  html += "</div>"

  if (!sectionCollapseState.response) {
    html += '<div class="section-body">'

    // Response content (assistant message)
    const responseContent = currentEntry.response?.content
    if (responseContent && (!filterRole || filterRole === "assistant")) {
      // Use full message object if it has role (preserves tool_calls for OpenAI format)
      const responseMsg = responseContent.role
        ? responseContent
        : { role: "assistant", content: responseContent.content ?? responseContent }
      html += renderMessage(responseMsg, filterType, false, null, toolUseNameMap)
    }

    // Error message
    if (currentEntry.response?.error) {
      html +=
        '<div class="error-block"><strong>Error:</strong> ' + escapeHtml(String(currentEntry.response.error)) + "</div>"
    }

    html += "</div>"
  }
  html += "</div>"

  // META INFO section (after response for better reading flow)
  const metaIcon = sectionCollapseState.meta ? "\u25B8" : "\u25BE"
  html += '<div class="section-block">'
  html += '<div class="section-header">'
  html += '<div class="section-header-left" onclick="toggleSection(\'meta\')">'
  html += '<span class="collapse-icon">' + metaIcon + "</span>"
  html += "META INFO"
  html += "</div>"
  html += '<div class="section-header-actions">'
  html +=
    '<button class="action-btn" onclick="event.stopPropagation();showRaw(\'Full Entry\', '
    + fullEntryRawIdx
    + ')" title="View Raw">'
    + ICON_CODE
    + "Raw</button>"
  html += "</div>"
  html += "</div>"

  if (!sectionCollapseState.meta) {
    // Collect all meta items into a flat array
    const items = []
    items.push(
      '<div class="info-item"><div class="info-label">Time</div><div class="info-value">'
        + formatDate(currentEntry.timestamp)
        + "</div></div>",
    )
    items.push(
      '<div class="info-item"><div class="info-label">Model</div><div class="info-value">'
        + escapeHtml(currentEntry.request?.model || "-")
        + "</div></div>",
      '<div class="info-item"><div class="info-label">Endpoint</div><div class="info-value"><span class="badge '
        + currentEntry.endpoint
        + '">'
        + currentEntry.endpoint
        + "</span></div></div>",
    )
    if (currentEntry.request?.stream) {
      items.push(
        '<div class="info-item"><div class="info-label">Stream</div><div class="info-value"><span class="badge stream">yes</span></div></div>',
      )
    }
    if (currentEntry.request?.max_tokens) {
      items.push(
        '<div class="info-item"><div class="info-label">Max Tokens</div><div class="info-value">'
          + currentEntry.request.max_tokens
          + "</div></div>",
      )
    }
    if (currentEntry.request?.temperature != null) {
      items.push(
        '<div class="info-item"><div class="info-label">Temperature</div><div class="info-value">'
          + currentEntry.request.temperature
          + "</div></div>",
      )
    }
    if (currentEntry.request?.tools?.length) {
      items.push(
        '<div class="info-item"><div class="info-label">Tools</div><div class="info-value">'
          + currentEntry.request.tools.length
          + " defined</div></div>",
      )
    }
    if (currentEntry.response?.stop_reason) {
      items.push(
        '<div class="info-item"><div class="info-label">Stop Reason</div><div class="info-value">'
          + escapeHtml(currentEntry.response.stop_reason)
          + "</div></div>",
      )
    }
    if (currentEntry.response?.success !== undefined) {
      items.push(
        '<div class="info-item"><div class="info-label">Status</div><div class="info-value '
          + (currentEntry.response.success !== false ? "status-ok" : "status-fail")
          + '">'
          + (currentEntry.response.success !== false ? "OK" : "Failed")
          + "</div></div>",
      )
    }

    // Usage items
    const usage = currentEntry.response?.usage
    if (usage) {
      items.push(
        '<div class="info-item"><div class="info-label">Input Tokens</div><div class="info-value number">'
          + formatNumber(usage.input_tokens)
          + "</div></div>",
      )
      items.push(
        '<div class="info-item"><div class="info-label">Output Tokens</div><div class="info-value number">'
          + formatNumber(usage.output_tokens)
          + "</div></div>",
      )
      if (usage.cache_read_input_tokens) {
        items.push(
          '<div class="info-item"><div class="info-label">Cache Read</div><div class="info-value number">'
            + formatNumber(usage.cache_read_input_tokens)
            + "</div></div>",
        )
      }
      if (usage.cache_creation_input_tokens) {
        items.push(
          '<div class="info-item"><div class="info-label">Cache Create</div><div class="info-value number">'
            + formatNumber(usage.cache_creation_input_tokens)
            + "</div></div>",
        )
      }
    }

    // Duration
    if (currentEntry.durationMs) {
      items.push(
        '<div class="info-item"><div class="info-label">Duration</div><div class="info-value">'
          + formatDuration(currentEntry.durationMs)
          + "</div></div>",
      )
    }

    // Truncation info
    if (truncation) {
      const pct = Math.round((1 - truncation.compactedTokens / truncation.originalTokens) * 100)
      items.push(
        '<div class="info-item"><div class="info-label">Truncated</div><div class="info-value truncation-value">'
          + truncation.removedMessageCount
          + " msgs removed ("
          + pct
          + "%)</div></div>",
      )
    }

    // Sanitization info
    if (rewrites?.sanitization) {
      const s = rewrites.sanitization
      if (s.totalBlocksRemoved > 0) {
        items.push(
          '<div class="info-item"><div class="info-label">Orphaned</div><div class="info-value truncation-value">'
            + s.totalBlocksRemoved
            + " blocks removed</div></div>",
        )
      }
      if (s.systemReminderRemovals > 0) {
        items.push(
          '<div class="info-item"><div class="info-label">Reminders</div><div class="info-value">'
            + s.systemReminderRemovals
            + " tags filtered</div></div>",
        )
      }
    }

    // Render as a single grid with two equal rows
    const cols = Math.ceil(items.length / 2)
    html += '<div class="info-card" style="grid-template-columns: repeat(' + cols + ', 1fr)">'
    html += items.join("")
    html += "</div>"
  }
  html += "</div>"

  html += "</div>"
  content.innerHTML = html

  // Show expand buttons for blocks that actually overflow
  updateExpandButtons()

  // Apply search highlighting if needed
  if (detailSearchQuery) {
    applySearchHighlight()
  }
}

let msgIdCounter = 0
function renderSystemMessage(system, rewrittenSystem) {
  let text = ""
  if (typeof system === "string") {
    text = system
  } else if (Array.isArray(system)) {
    text = system.map((b) => b.text || "").join("\n")
  }

  const isRewritten = rewrittenSystem != null && rewrittenSystem !== text

  const msgId = "msg-sys-" + msgIdCounter++
  const summary = escapeHtml(text.length > 80 ? text.slice(0, 80) + "..." : text)
  const displayText = detailSearchQuery ? highlightSearch(text, detailSearchQuery) : escapeHtml(text)
  const sysRawIdx = registerRawData(system)

  let classes = "message-block"
  if (isRewritten) classes += " rewritten"
  let html = '<div class="' + classes + '" id="' + msgId + '">'
  html += '<div class="message-header">'
  html += '<div class="message-header-left">'
  html += '<span class="collapse-icon" onclick="toggleMessage(\'' + msgId + "')\">\u25BE</span>"
  html += '<span class="message-role system">SYSTEM</span>'
  if (isRewritten) {
    html += '<span class="rewrite-badge rewritten">(rewritten)</span>'
  }
  html += '<span class="collapsed-summary" style="display:none">' + summary + "</span>"
  html += "</div>"
  html += '<div class="message-header-actions">'

  if (isRewritten) {
    html += '<div class="rewrite-toggle">'
    html +=
      '<button class="rewrite-tab active" data-mode="original" onclick="event.stopPropagation();switchRewriteView(\''
      + msgId
      + "','original')\">Original</button>"
    html +=
      '<button class="rewrite-tab" data-mode="rewritten" onclick="event.stopPropagation();switchRewriteView(\''
      + msgId
      + "','rewritten')\">Rewritten</button>"
    html +=
      '<button class="rewrite-tab" data-mode="diff" onclick="event.stopPropagation();switchRewriteView(\''
      + msgId
      + "','diff')\">Diff</button>"
    html += "</div>"
  }

  html +=
    '<button class="action-btn expand-toggle" data-target="'
    + msgId
    + '" onclick="event.stopPropagation();toggleBodyExpand(this)" style="display:none">'
    + ICON_EXPAND
    + "Expand</button>"
  html +=
    '<button class="action-btn" onclick="event.stopPropagation();copyText(this)" data-text="'
    + escapeHtml(text).replaceAll('"', "&quot;")
    + '" title="Copy">'
    + ICON_COPY
    + "Copy</button>"
  html +=
    '<button class="action-btn" onclick="event.stopPropagation();showRaw(\'System\', '
    + sysRawIdx
    + ')" title="View Raw">'
    + ICON_CODE
    + "Raw</button>"
  html += "</div>"
  html += "</div>"

  if (isRewritten) {
    html += '<div class="message-body message-body-original body-collapsed">'
    html += '<div class="content-text">' + displayText + "</div>"
    html += "</div>"

    const rewrittenDisplay =
      detailSearchQuery ? highlightSearch(rewrittenSystem, detailSearchQuery) : escapeHtml(rewrittenSystem)
    html += '<div class="message-body message-body-rewritten body-collapsed" style="display:none">'
    html += '<div class="content-text">' + rewrittenDisplay + "</div>"
    html += "</div>"

    html += '<div class="message-body message-body-diff body-collapsed" style="display:none">'
    var sysDiffHtml = computeTextDiff(text, rewrittenSystem)
    html += sysDiffHtml || '<div class="diff-no-changes">No differences</div>'
    html += "</div>"
  } else {
    html += '<div class="message-body body-collapsed">'
    html += '<div class="content-text">' + displayText + "</div>"
    html += "</div>"
  }

  html += "</div>"
  return html
}

/**
 * Compare two messages' content for equality.
 * Handles both Anthropic format (content as array of blocks) and
 * OpenAI format (content as string). Returns true if content is equivalent.
 */
function messagesContentEqual(msgA, msgB) {
  var a = msgA.content
  var b = msgB.content
  // Both strings: direct compare
  if (typeof a === "string" && typeof b === "string") return a === b
  // Both arrays: compare JSON (handles tool_use, tool_result, etc.)
  if (Array.isArray(a) && Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b)
  // Mixed formats (Anthropic vs OpenAI): compare extracted text
  return extractMessageText(msgA) === extractMessageText(msgB)
}

function renderMessageContent(content, filterType, aggregateTools, toolResultMap, toolUseNameMap, msg) {
  let html = ""
  if (typeof content === "string") {
    if (!filterType || filterType === "text") {
      html += renderTextBlock(content, null)
    }
  } else if (Array.isArray(content)) {
    let hasVisibleBlocks = false
    for (const block of content) {
      if (aggregateTools && block.type === "tool_result") continue
      if (filterType && block.type !== filterType) continue
      hasVisibleBlocks = true
      switch (block.type) {
        case "text": {
          html += renderTextBlock(block.text, block)

          break
        }
        case "tool_use": {
          html += renderToolUseBlock(block, aggregateTools, toolResultMap)

          break
        }
        case "tool_result": {
          html += renderToolResultBlock(block, toolUseNameMap)

          break
        }
        case "image":
        case "image_url": {
          html += renderImageBlock(block)

          break
        }
        case "thinking": {
          html += renderThinkingBlock(block)

          break
        }
        default: {
          html += renderGenericBlock(block)
        }
      }
    }

    if (!hasVisibleBlocks && aggregateTools) {
      const toolIds = content
        .filter(function (b) {
          return b.type === "tool_result" && b.tool_use_id
        })
        .map(function (b) {
          return b.tool_use_id
        })
      if (toolIds.length > 0) {
        html += '<div class="aggregated-links">'
        html += '<span class="aggregated-label">Tool results aggregated to:</span>'
        for (const id of toolIds) {
          html += ' <a class="tool-link" onclick="scrollToToolUse(\'' + id + "')\">\u2190 " + escapeHtml(id) + "</a>"
        }
        html += "</div>"
      }
    }
  }
  // OpenAI format: render tool_calls from the message object
  if (msg && msg.tool_calls && Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      if (filterType && filterType !== "tool_use") continue
      // Convert OpenAI tool_call to Anthropic-like tool_use block for rendering
      var toolUseBlock = {
        type: "tool_use",
        id: tc.id,
        name: tc.function ? tc.function.name : "unknown",
        input: tc.function ? tc.function.arguments : "{}",
      }
      // Try to parse arguments as JSON for prettier display
      try { toolUseBlock.input = JSON.parse(toolUseBlock.input) } catch (e) { /* keep as string */ }
      html += renderToolUseBlock(toolUseBlock, aggregateTools, toolResultMap)
    }
  }
  // OpenAI format: tool response message (role=tool with tool_call_id)
  if (msg && msg.role === "tool" && msg.tool_call_id && typeof content === "string") {
    if (!filterType || filterType === "tool_result") {
      var toolResultBlock = {
        type: "tool_result",
        tool_use_id: msg.tool_call_id,
        content: content,
      }
      html += renderToolResultBlock(toolResultBlock, toolUseNameMap)
    }
  }
  return html
}

function extractMessageText(msg) {
  const content = msg.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    var parts = []
    for (var b of content) {
      if (b.type === "text" && b.text) {
        parts.push(b.text)
      } else if (b.type === "tool_use") {
        var input = typeof b.input === "string" ? b.input : JSON.stringify(b.input || {}, null, 2)
        parts.push("[tool_use: " + (b.name || "") + "]\n" + input)
      } else if (b.type === "tool_result") {
        var rc = typeof b.content === "string" ? b.content : JSON.stringify(b.content, null, 2)
        parts.push("[tool_result: " + (b.tool_use_id || "") + "]\n" + (rc || ""))
      }
    }
    return parts.join("\n")
  }
  return ""
}

function computeTextDiff(oldText, newText) {
  if (oldText === newText) return ""
  // Use jsdiff to create unified diff, then diff2html to render side-by-side
  var diffStr = Diff.createPatch("message", oldText, newText, "original", "rewritten", { context: 3 })
  return Diff2Html.html(diffStr, {
    outputFormat: "side-by-side",
    drawFileList: false,
    matching: "words",
    diffStyle: "word",
  })
}

function switchRewriteView(msgId, mode) {
  const block = document.getElementById(msgId)
  if (!block) return

  // Update tab buttons
  const tabs = block.querySelectorAll(".rewrite-tab")
  for (const tab of tabs) {
    tab.classList.toggle("active", tab.dataset.mode === mode)
  }

  // Show/hide body containers
  const original = block.querySelector(".message-body-original")
  const rewritten = block.querySelector(".message-body-rewritten")
  const diff = block.querySelector(".message-body-diff")
  if (original) original.style.display = mode === "original" ? "" : "none"
  if (rewritten) rewritten.style.display = mode === "rewritten" ? "" : "none"
  if (diff) diff.style.display = mode === "diff" ? "" : "none"

  // Reset message-level expand toggle text to match newly visible body's state
  var expandToggle = block.querySelector(":scope > .message-header .expand-toggle")
  if (expandToggle) {
    var visibleBody =
      mode === "original" ? original
      : mode === "rewritten" ? rewritten
      : diff
    if (visibleBody) {
      var isCollapsed = visibleBody.classList.contains("body-collapsed")
      expandToggle.innerHTML = isCollapsed ? ICON_EXPAND + "Expand" : ICON_CONTRACT + "Collapse"
    }
  }

  // Re-check expand buttons for newly visible content
  updateExpandButtons()
}

function renderMessage(
  msg,
  filterType,
  aggregateTools,
  toolResultMap,
  toolUseNameMap,
  isTruncated,
  isRewritten,
  rewrittenMsg,
) {
  const role = msg.role || "unknown"
  const content = msg.content

  const msgId = "msg-" + role + "-" + msgIdCounter++
  const summary = escapeHtml(getMessageSummary(content))
  const msgRawIdx = registerRawData(msg)

  let classes = "message-block"
  if (isTruncated) classes += " truncated"
  if (isRewritten && !isTruncated) classes += " rewritten"
  let html = '<div class="' + classes + '" id="' + msgId + '">'
  html += '<div class="message-header">'
  html += '<div class="message-header-left">'
  html += '<span class="collapse-icon" onclick="toggleMessage(\'' + msgId + "')\">\u25BE</span>"
  html += '<span class="message-role ' + role + '">' + role.toUpperCase() + "</span>"
  if (isTruncated) {
    html += '<span class="rewrite-badge deleted">(deleted)</span>'
  } else if (isRewritten) {
    html += '<span class="rewrite-badge rewritten">(rewritten)</span>'
  }
  html += '<span class="collapsed-summary" style="display:none">' + summary + "</span>"
  html += "</div>"
  html += '<div class="message-header-actions">'

  // Rewrite toggle buttons (only for rewritten messages with available rewritten data)
  if (isRewritten && !isTruncated && rewrittenMsg) {
    html += '<div class="rewrite-toggle">'
    html +=
      '<button class="rewrite-tab active" data-mode="original" onclick="event.stopPropagation();switchRewriteView(\''
      + msgId
      + "','original')\">Original</button>"
    html +=
      '<button class="rewrite-tab" data-mode="rewritten" onclick="event.stopPropagation();switchRewriteView(\''
      + msgId
      + "','rewritten')\">Rewritten</button>"
    html +=
      '<button class="rewrite-tab" data-mode="diff" onclick="event.stopPropagation();switchRewriteView(\''
      + msgId
      + "','diff')\">Diff</button>"
    html += "</div>"
  }

  html +=
    '<button class="action-btn expand-toggle" data-target="'
    + msgId
    + '" onclick="event.stopPropagation();toggleBodyExpand(this)" style="display:none">'
    + ICON_EXPAND
    + "Expand</button>"
  html +=
    '<button class="action-btn" onclick="event.stopPropagation();showRaw(\''
    + role
    + "', "
    + msgRawIdx
    + ')" title="View Raw">'
    + ICON_CODE
    + "Raw</button>"
  html += "</div>"
  html += "</div>"

  if (isRewritten && !isTruncated && rewrittenMsg) {
    // Three switchable body containers
    html += '<div class="message-body message-body-original">'
    html += renderMessageContent(content, filterType, aggregateTools, toolResultMap, toolUseNameMap, msg)
    html += "</div>"

    html += '<div class="message-body message-body-rewritten" style="display:none">'
    html += renderMessageContent(rewrittenMsg.content, filterType, aggregateTools, toolResultMap, toolUseNameMap, rewrittenMsg)
    html += "</div>"

    html += '<div class="message-body message-body-diff body-collapsed" style="display:none">'
    var diffHtml = computeTextDiff(extractMessageText(msg), extractMessageText(rewrittenMsg))
    html += diffHtml || '<div class="diff-no-changes">No differences</div>'
    html += "</div>"
  } else {
    // Standard single body
    html += '<div class="message-body">'
    html += renderMessageContent(content, filterType, aggregateTools, toolResultMap, toolUseNameMap, msg)
    html += "</div>"
  }

  html += "</div>"
  return html
}

let blockIdCounter = 0
function renderTextBlock(text, block) {
  const blockId = "cb-" + blockIdCounter++
  const summary = escapeHtml(getContentBlockSummary(block || { type: "text", text: text || "" }))
  const displayText = detailSearchQuery ? highlightSearch(text, detailSearchQuery) : escapeHtml(text)
  const blockData = block || { type: "text", text: text || "" }
  const blockRawIdx = registerRawData(blockData)

  let html = '<div class="content-block" id="' + blockId + '">'
  html += '<div class="content-block-header">'
  html += '<div class="content-block-header-left">'
  html += '<span class="collapse-icon" onclick="toggleContentBlock(\'' + blockId + "')\">\u25BE</span>"
  html += '<span class="content-type text">TEXT</span>'
  html += '<span class="collapsed-summary" style="display:none">' + summary + "</span>"
  html += "</div>"
  html += '<div class="content-block-actions">'
  html +=
    '<button class="action-btn expand-toggle" data-target="'
    + blockId
    + '" onclick="event.stopPropagation();toggleBodyExpand(this)" style="display:none">'
    + ICON_EXPAND
    + "Expand</button>"
  html +=
    '<button class="action-btn" onclick="event.stopPropagation();copyText(this)" data-text="'
    + escapeHtml(text || "").replaceAll('"', "&quot;")
    + '" title="Copy">'
    + ICON_COPY
    + "Copy</button>"
  html +=
    '<button class="action-btn" onclick="event.stopPropagation();showRaw(\'Text\', '
    + blockRawIdx
    + ')" title="View Raw">'
    + ICON_CODE
    + "Raw</button>"
  html += "</div>"
  html += "</div>"
  html += '<div class="content-block-body body-collapsed">'
  html += '<div class="content-text">' + displayText + "</div>"
  html += "</div>"
  html += "</div>"
  return html
}

function renderToolUseBlock(block, aggregateTools, toolResultMap) {
  const blockId = "cb-" + blockIdCounter++
  const summary = escapeHtml(block.name || "")
  const blockRawIdx = registerRawData(block)
  const inputJson = typeof block.input === "string" ? block.input : JSON.stringify(block.input || {}, null, 2)

  let html = '<div class="content-block" id="tool-' + block.id + '">'
  html += '<div class="content-block-header">'
  html += '<div class="content-block-header-left">'
  html += '<span class="collapse-icon" onclick="toggleContentBlock(\'tool-' + block.id + "')\">\u25BE</span>"
  html += '<span class="content-type tool_use">TOOL USE</span>'
  html += '<span class="tool-name">' + escapeHtml(block.name) + "</span>"
  html += '<span class="tool-id">' + escapeHtml(block.id) + "</span>"
  html += '<span class="collapsed-summary" style="display:none">' + summary + "</span>"
  html += "</div>"
  html += '<div class="content-block-actions">'
  html +=
    '<button class="action-btn expand-toggle" data-target="tool-'
    + block.id
    + '" onclick="event.stopPropagation();toggleBodyExpand(this)" style="display:none">'
    + ICON_EXPAND
    + "Expand</button>"
  html +=
    '<button class="action-btn" onclick="event.stopPropagation();copyText(this)" data-text="'
    + escapeHtml(inputJson).replaceAll('"', "&quot;")
    + '" title="Copy">'
    + ICON_COPY
    + "Copy</button>"
  html +=
    '<button class="action-btn" onclick="event.stopPropagation();showRaw(\'Tool Use\', '
    + blockRawIdx
    + ')" title="View Raw">'
    + ICON_CODE
    + "Raw</button>"
  html += "</div>"
  html += "</div>"
  html += '<div class="content-block-body body-collapsed">'
  html += '<div class="tool-input">' + escapeHtml(inputJson) + "</div>"

  if (aggregateTools && toolResultMap[block.id]) {
    const result = toolResultMap[block.id]
    const resultContent = typeof result.content === "string" ? result.content : JSON.stringify(result.content, null, 2)
    const resultRawIdx = registerRawData(result)
    html += '<div class="tool-result-inline">'
    html += '<div class="tool-result-inline-header">'
    html += "<span>RESULT</span>"
    html +=
      '<button class="action-btn" onclick="event.stopPropagation();showRaw(\'Tool Result\', '
      + resultRawIdx
      + ')" title="View Raw">'
      + ICON_CODE
      + "Raw</button>"
    html += "</div>"
    html += '<div class="tool-result-inline-body">' + escapeHtml(resultContent) + "</div>"
    html += "</div>"
  } else if (!aggregateTools && toolResultMap) {
    // Only show "Jump to result" when tool results exist in the conversation
    // (response section passes null toolResultMap since responses never contain tool_result)
    html += '<a class="tool-link" onclick="scrollToToolResult(\'' + block.id + "')\">\u2192 Jump to result</a>"
  }

  html += "</div></div>"
  return html
}

function renderToolResultBlock(block, toolUseNameMap) {
  const blockRawIdx = registerRawData(block)
  const content = typeof block.content === "string" ? block.content : JSON.stringify(block.content, null, 2)
  const toolName = toolUseNameMap && block.tool_use_id ? toolUseNameMap[block.tool_use_id] : ""
  const summary = escapeHtml("for " + (toolName || block.tool_use_id || ""))

  let html = '<div class="content-block" id="result-' + block.tool_use_id + '">'
  html += '<div class="content-block-header">'
  html += '<div class="content-block-header-left">'
  html += '<span class="collapse-icon" onclick="toggleContentBlock(\'result-' + block.tool_use_id + "')\">\u25BE</span>"
  html += '<span class="content-type tool_result">TOOL RESULT</span>'
  if (toolName) {
    html += '<span class="tool-name">' + escapeHtml(toolName) + "</span>"
  }
  html += '<span class="tool-id">for ' + escapeHtml(block.tool_use_id) + "</span>"
  html += '<span class="collapsed-summary" style="display:none">' + summary + "</span>"
  html += "</div>"
  html += '<div class="content-block-actions">'
  html +=
    '<button class="action-btn expand-toggle" data-target="result-'
    + block.tool_use_id
    + '" onclick="event.stopPropagation();toggleBodyExpand(this)" style="display:none">'
    + ICON_EXPAND
    + "Expand</button>"
  html +=
    '<button class="action-btn" onclick="event.stopPropagation();copyText(this)" data-text="'
    + escapeHtml(content).replaceAll('"', "&quot;")
    + '" title="Copy">'
    + ICON_COPY
    + "Copy</button>"
  html +=
    '<a class="tool-link" onclick="event.stopPropagation();scrollToToolUse(\''
    + block.tool_use_id
    + "')\">\u2190 Jump to call</a>"
  html +=
    '<button class="action-btn" onclick="event.stopPropagation();showRaw(\'Tool Result\', '
    + blockRawIdx
    + ')" title="View Raw">'
    + ICON_CODE
    + "Raw</button>"
  html += "</div>"
  html += "</div>"
  html += '<div class="content-block-body body-collapsed">'
  html += '<div class="content-text">' + escapeHtml(content) + "</div>"
  html += "</div>"
  html += "</div>"
  return html
}

function renderImageBlock(block) {
  const blockRawIdx = registerRawData(block)
  const mediaType = block.source?.media_type || block.media_type || "unknown"

  let html = '<div class="content-block">'
  html += '<div class="content-block-header">'
  html += '<div class="content-block-header-left">'
  html += '<span class="content-type image">IMAGE</span>'
  html += '<span style="font-size:10px;color:var(--text-dim);">' + escapeHtml(mediaType) + "</span>"
  html += "</div>"
  html += '<div class="content-block-actions">'
  html +=
    '<button class="action-btn" onclick="event.stopPropagation();showRaw(\'Image\', '
    + blockRawIdx
    + ')" title="View Raw">'
    + ICON_CODE
    + "Raw</button>"
  html += "</div>"
  html += "</div>"
  html += '<div class="content-block-body">'
  html += '<div style="color:var(--text-muted);font-size:12px;">[Image content - base64 encoded]</div>'
  html += "</div>"
  html += "</div>"
  return html
}

function renderThinkingBlock(block) {
  const blockId = "cb-" + blockIdCounter++
  const blockRawIdx = registerRawData(block)
  const text = block.thinking || ""
  const summary = escapeHtml(text.length > 60 ? text.slice(0, 60) + "..." : text)

  let html = '<div class="content-block" id="' + blockId + '">'
  html += '<div class="content-block-header">'
  html += '<div class="content-block-header-left">'
  html += '<span class="collapse-icon" onclick="toggleContentBlock(\'' + blockId + "')\">\u25BE</span>"
  html += '<span class="content-type thinking">THINKING</span>'
  html += '<span class="collapsed-summary" style="display:none">' + summary + "</span>"
  html += "</div>"
  html += '<div class="content-block-actions">'
  html +=
    '<button class="action-btn expand-toggle" data-target="'
    + blockId
    + '" onclick="event.stopPropagation();toggleBodyExpand(this)" style="display:none">'
    + ICON_EXPAND
    + "Expand</button>"
  html +=
    '<button class="action-btn" onclick="event.stopPropagation();copyText(this)" data-text="'
    + escapeHtml(text).replaceAll('"', "&quot;")
    + '" title="Copy">'
    + ICON_COPY
    + "Copy</button>"
  html +=
    '<button class="action-btn" onclick="event.stopPropagation();showRaw(\'Thinking\', '
    + blockRawIdx
    + ')" title="View Raw">'
    + ICON_CODE
    + "Raw</button>"
  html += "</div>"
  html += "</div>"
  html += '<div class="content-block-body body-collapsed">'
  html += '<div class="content-text">' + escapeHtml(text) + "</div>"
  html += "</div>"
  html += "</div>"
  return html
}

function renderGenericBlock(block) {
  const blockRawIdx = registerRawData(block)

  let html = '<div class="content-block">'
  html += '<div class="content-block-header">'
  html +=
    '<div class="content-block-header-left"><span class="content-type text">'
    + escapeHtml(block.type || "UNKNOWN")
    + "</span></div>"
  html += '<div class="content-block-actions">'
  html +=
    '<button class="action-btn" onclick="event.stopPropagation();showRaw(\'Block\', '
    + blockRawIdx
    + ')" title="View Raw">'
    + ICON_CODE
    + "Raw</button>"
  html += "</div>"
  html += "</div>"
  html += '<div class="content-block-body">'
  html += '<pre style="font-size:11px;margin:0;">' + escapeHtml(JSON.stringify(block, null, 2)) + "</pre>"
  html += "</div>"
  html += "</div>"
  return html
}

function applySearchHighlight() {
  const firstMatch = document.querySelector(".search-highlight")
  if (firstMatch) {
    firstMatch.scrollIntoView({ behavior: "smooth", block: "center" })
  }
}

// UI Actions
function toggleBodyExpand(toggleEl) {
  var targetId = toggleEl.dataset.target
  var container = document.getElementById(targetId)
  if (!container) return

  var body
  if (container.classList.contains("message-block")) {
    // Message-level: find the currently visible direct message-body
    var bodies = container.querySelectorAll(":scope > .message-body")
    body = null
    for (const body_ of bodies) {
      if (body_.style.display !== "none") {
        body = body_
        break
      }
    }
  } else {
    // Content-block level: find the content-block-body
    body = container.querySelector(".content-block-body")
  }

  if (!body) return
  var isCollapsed = body.classList.toggle("body-collapsed")
  toggleEl.innerHTML = isCollapsed ? ICON_EXPAND + "Expand" : ICON_CONTRACT + "Collapse"
}

function updateExpandButtons() {
  // Handle content-block level expand buttons
  var contentBlocks = document.querySelectorAll(".content-block")
  for (var i = 0; i < contentBlocks.length; i++) {
    var toggle = contentBlocks[i].querySelector(".expand-toggle")
    if (!toggle) continue
    var body = contentBlocks[i].querySelector(".content-block-body")
    toggle.style.display = body && body.classList.contains("body-collapsed") && body.scrollHeight > 200 ? "" : "none"
  }

  // Handle message-block level expand buttons
  var msgBlocks = document.querySelectorAll(".message-block")
  for (var i = 0; i < msgBlocks.length; i++) {
    // Only look at direct expand-toggle in message-header (not nested in content-blocks)
    var toggle = msgBlocks[i].querySelector(":scope > .message-header .expand-toggle")
    if (!toggle) continue
    // Find the currently visible message-body
    var bodies = msgBlocks[i].querySelectorAll(":scope > .message-body")
    var visibleBody = null
    for (const body_ of bodies) {
      if (body_.style.display !== "none") {
        visibleBody = body_
        break
      }
    }
    toggle.style.display =
      visibleBody && visibleBody.classList.contains("body-collapsed") && visibleBody.scrollHeight > 200 ? "" : "none"
  }
}

function scrollToToolUse(id) {
  const el = document.getElementById("tool-" + id)
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "center" })
    highlightBlock(el)
  }
}

function scrollToToolResult(id) {
  const el = document.getElementById("result-" + id)
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "center" })
    highlightBlock(el)
  }
}

function highlightBlock(el) {
  el.classList.remove("highlight-flash")
  void el.offsetWidth
  el.classList.add("highlight-flash")
}

function copyText(btn) {
  const text = btn.dataset.text
  navigator.clipboard.writeText(text).then(() => {
    const origHtml = btn.innerHTML
    btn.innerHTML = "\u2713 Copied"
    setTimeout(() => (btn.innerHTML = origHtml), 1000)
  })
}

function showRaw(title, data) {
  const resolvedData = typeof data === "number" ? rawDataRegistry[data] : data
  document.querySelector("#raw-modal-title").textContent = title + " - Raw JSON"

  // Use JSON tree view
  const modalBody = document.querySelector("#raw-modal .modal-body")
  modalBody.innerHTML = ""
  const tree = buildJsonTree(resolvedData, 3)
  modalBody.append(tree)

  document.querySelector("#raw-modal").classList.add("open")
  // Store the data for copy
  modalBody.dataset.rawJson = JSON.stringify(resolvedData, null, 2)
}

function closeRawModal(event) {
  if (!event || event.target === event.currentTarget) {
    document.querySelector("#raw-modal").classList.remove("open")
  }
}

function copyRawContent() {
  const modalBody = document.querySelector("#raw-modal .modal-body")
  navigator.clipboard.writeText(modalBody.dataset.rawJson || "")
}

function toggleExportMenu() {
  document.querySelector("#export-menu").classList.toggle("open")
}

function closeExportMenu() {
  document.querySelector("#export-menu").classList.remove("open")
}

function exportData(format) {
  globalThis.location.href = "/history/api/export?format=" + format
  closeExportMenu()
}

function onSessionChange() {
  currentSessionId = document.querySelector("#session-select").value || null
  currentPage = 1
  loadEntries()
}

function debounceListSearch() {
  clearTimeout(listSearchTimer)
  listSearchTimer = setTimeout(() => {
    currentPage = 1
    loadEntries()
  }, 300)
}

function debounceDetailSearch() {
  clearTimeout(detailSearchTimer)
  detailSearchTimer = setTimeout(() => {
    detailSearchQuery = document.querySelector("#detail-search").value
    renderDetail()
  }, 300)
}

async function clearAll() {
  if (!confirm("Are you sure you want to clear all history?")) return
  try {
    await fetch("/history/api/entries", { method: "DELETE" })
    hideDetailView()
    loadSessions()
    loadStats()
    loadEntries()
  } catch (e) {
    console.error("Failed to clear history:", e)
  }
}

function refresh() {
  const listEl = document.querySelector("#request-list")
  const prevOpacity = listEl.style.opacity
  listEl.style.opacity = "0.5"
  listEl.style.transition = "opacity 0.15s"

  Promise.all([loadSessions(), loadStats(), loadEntries()]).then(() => {
    listEl.style.opacity = prevOpacity || ""
    if (currentEntryId) {
      selectEntry(currentEntryId)
    }
  })
}

// Keyboard navigation
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeRawModal()
    closeExportMenu()
  }

  if (document.activeElement.tagName !== "INPUT" && document.activeElement.tagName !== "SELECT") {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      const items = document.querySelectorAll(".request-item")
      if (items.length === 0) return

      let currentIndex = -1
      for (const [index, item] of items.entries()) {
        if (item.classList.contains("selected")) currentIndex = index
      }

      let newIndex
      if (e.key === "ArrowDown") {
        newIndex = currentIndex < items.length - 1 ? currentIndex + 1 : 0
      } else {
        newIndex = currentIndex > 0 ? currentIndex - 1 : items.length - 1
      }

      const newItem = items[newIndex]
      selectEntry(newItem.dataset.id)
      newItem.scrollIntoView({ block: "nearest" })
    }

    if (e.key === "/") {
      e.preventDefault()
      document.querySelector("#list-search").focus()
    }
  }
})

// Initialize
loadSessions()
loadStats()
loadEntries()

// Inject SVG icons into static elements
document.querySelector("#list-search-icon").innerHTML = ICON_SEARCH
document.querySelector("#detail-search-icon").innerHTML = ICON_SEARCH
document.querySelector("#btn-close-raw").innerHTML = ICON_CLOSE
document.querySelector("#btn-refresh").innerHTML = ICON_REFRESH + "Refresh"
document.querySelector("#btn-export").innerHTML = ICON_DOWNLOAD + "Export"
document.querySelector("#btn-clear").innerHTML = ICON_TRASH + "Clear"

// Close export menu on click outside
document.addEventListener("click", function (e) {
  var wrapper = document.querySelector(".export-wrapper")
  if (wrapper && !wrapper.contains(e.target)) {
    closeExportMenu()
  }
})
