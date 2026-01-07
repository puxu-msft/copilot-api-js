// Fullscreen TUI renderer using Ink
// Provides an interactive terminal interface with tabs for Active/Completed/Errors

import { Box, render, Text, useInput, useStdout } from "ink"
import React, { useEffect, useState } from "react"

import type { RequestUpdate, TrackedRequest, TuiRenderer } from "./types"

type TabType = "active" | "completed" | "errors"

interface TuiState {
  activeRequests: Map<string, TrackedRequest>
  completedRequests: Array<TrackedRequest>
  errorRequests: Array<TrackedRequest>
}

// Shared state that the renderer updates
const tuiState: TuiState = {
  activeRequests: new Map(),
  completedRequests: [],
  errorRequests: [],
}

// Event emitter for state changes
type StateListener = () => void
const listeners: Array<StateListener> = []
function notifyListeners(): void {
  for (const listener of listeners) {
    listener()
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatNumber(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

function formatTokens(input?: number, output?: number): string {
  if (input === undefined || output === undefined) return "-"
  return `${formatNumber(input)}/${formatNumber(output)}`
}

function getElapsedTime(startTime: number): string {
  return formatDuration(Date.now() - startTime)
}

// Tab header component
function TabHeader({
  currentTab,
  counts,
}: {
  currentTab: TabType
  counts: { active: number; completed: number; errors: number }
}): React.ReactElement {
  const tabs: Array<{ key: TabType; label: string; count: number }> = [
    { key: "active", label: "Active", count: counts.active },
    { key: "completed", label: "Completed", count: counts.completed },
    { key: "errors", label: "Errors", count: counts.errors },
  ]

  return (
    <Box borderStyle="single" paddingX={1}>
      {tabs.map((tab, idx) => (
        <React.Fragment key={tab.key}>
          {idx > 0 && <Text> │ </Text>}
          <Text
            bold={currentTab === tab.key}
            color={currentTab === tab.key ? "cyan" : undefined}
            inverse={currentTab === tab.key}
          >
            {" "}
            [{idx + 1}] {tab.label} ({tab.count}){" "}
          </Text>
        </React.Fragment>
      ))}
      <Text dimColor> │ Press 1/2/3 to switch tabs, q to quit</Text>
    </Box>
  )
}

function getStatusColor(status: string): string {
  if (status === "streaming") return "yellow"
  if (status === "queued") return "gray"
  return "blue"
}

function getStatusIcon(status: string): string {
  if (status === "streaming") return "⟳"
  if (status === "queued") return "◷"
  return "●"
}

// Active request row
function ActiveRequestRow({
  request,
}: {
  request: TrackedRequest
}): React.ReactElement {
  const [, setTick] = useState(0)

  // Update elapsed time every second
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(interval)
  }, [])

  const statusColor = getStatusColor(request.status)
  const statusIcon = getStatusIcon(request.status)

  return (
    <Box>
      <Text color={statusColor}>{statusIcon} </Text>
      <Text bold>{request.method}</Text>
      <Text> {request.path} </Text>
      <Text dimColor>{getElapsedTime(request.startTime)} </Text>
      {request.queuePosition !== undefined && request.queuePosition > 0 && (
        <Text color="gray">[queue #{request.queuePosition}] </Text>
      )}
      <Text color="magenta">{request.model}</Text>
    </Box>
  )
}

// Completed request row
function CompletedRequestRow({
  request,
}: {
  request: TrackedRequest
}): React.ReactElement {
  const isError = request.status === "error" || (request.statusCode ?? 0) >= 400

  return (
    <Box>
      <Text color={isError ? "red" : "green"}>{isError ? "✗" : "✓"} </Text>
      <Text bold>{request.method}</Text>
      <Text> {request.path} </Text>
      <Text color={isError ? "red" : "green"}>
        {request.statusCode ?? "-"}{" "}
      </Text>
      <Text dimColor>{formatDuration(request.durationMs ?? 0)} </Text>
      <Text>{formatTokens(request.inputTokens, request.outputTokens)} </Text>
      <Text color="magenta">{request.model}</Text>
    </Box>
  )
}

// Error request row
function ErrorRequestRow({
  request,
}: {
  request: TrackedRequest
}): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Box>
        <Text color="red">✗ </Text>
        <Text bold>{request.method}</Text>
        <Text> {request.path} </Text>
        <Text color="red">{request.statusCode ?? "-"} </Text>
        <Text dimColor>{formatDuration(request.durationMs ?? 0)} </Text>
        <Text color="magenta">{request.model}</Text>
      </Box>
      {request.error && (
        <Box marginLeft={2}>
          <Text color="red" dimColor>
            └─ {request.error}
          </Text>
        </Box>
      )}
    </Box>
  )
}

// Content panel component
function ContentPanel({
  currentTab,
  activeList,
  completedList,
  errorList,
  contentHeight,
}: {
  currentTab: TabType
  activeList: Array<TrackedRequest>
  completedList: Array<TrackedRequest>
  errorList: Array<TrackedRequest>
  contentHeight: number
}): React.ReactElement {
  if (currentTab === "active") {
    if (activeList.length === 0) {
      return <Text dimColor>No active requests</Text>
    }
    return (
      <>
        {activeList.slice(0, contentHeight).map((req) => (
          <ActiveRequestRow key={req.id} request={req} />
        ))}
      </>
    )
  }

  if (currentTab === "completed") {
    if (completedList.length === 0) {
      return <Text dimColor>No completed requests</Text>
    }
    return (
      <>
        {completedList
          .slice(-contentHeight)
          .reverse()
          .map((req) => (
            <CompletedRequestRow key={req.id} request={req} />
          ))}
      </>
    )
  }

  // errors tab
  if (errorList.length === 0) {
    return <Text dimColor>No errors</Text>
  }
  return (
    <>
      {errorList
        .slice(-contentHeight)
        .reverse()
        .map((req) => (
          <ErrorRequestRow key={req.id} request={req} />
        ))}
    </>
  )
}

// Main TUI App component
function TuiApp(): React.ReactElement {
  const [currentTab, setCurrentTab] = useState<TabType>("active")
  const [, forceUpdate] = useState(0)
  const { stdout } = useStdout()

  // Subscribe to state changes
  useEffect(() => {
    const listener = (): void => forceUpdate((n) => n + 1)
    listeners.push(listener)
    return () => {
      const idx = listeners.indexOf(listener)
      if (idx !== -1) listeners.splice(idx, 1)
    }
  }, [])

  // Handle keyboard input
  useInput((input, key) => {
    switch (input) {
      case "1": {
        setCurrentTab("active")
        break
      }
      case "2": {
        setCurrentTab("completed")
        break
      }
      case "3": {
        setCurrentTab("errors")
        break
      }
      default: {
        if (input === "q" || (key.ctrl && input === "c")) {
          process.exit(0)
        }
      }
    }
  })

  const activeList = Array.from(tuiState.activeRequests.values())
  const completedList = tuiState.completedRequests
  const errorList = tuiState.errorRequests

  const counts = {
    active: activeList.length,
    completed: completedList.length,
    errors: errorList.length,
  }

  // Calculate available height
  const terminalHeight = stdout.rows || 24
  const headerHeight = 3 // Tab header
  const footerHeight = 1 // Footer
  const contentHeight = terminalHeight - headerHeight - footerHeight - 2

  return (
    <Box flexDirection="column" height={terminalHeight}>
      <TabHeader currentTab={currentTab} counts={counts} />
      <Box
        flexDirection="column"
        height={contentHeight}
        borderStyle="single"
        paddingX={1}
        overflow="hidden"
      >
        <ContentPanel
          currentTab={currentTab}
          activeList={activeList}
          completedList={completedList}
          errorList={errorList}
          contentHeight={contentHeight}
        />
      </Box>
      <Box paddingX={1}>
        <Text dimColor>
          copilot-api │ Active: {counts.active} │ Completed: {counts.completed}{" "}
          │ Errors: {counts.errors}
        </Text>
      </Box>
    </Box>
  )
}

/**
 * Fullscreen TUI renderer using Ink
 * Provides interactive terminal interface with tabs
 */
export class FullscreenRenderer implements TuiRenderer {
  private inkInstance: ReturnType<typeof render> | null = null
  private maxHistory = 100

  constructor(options?: { maxHistory?: number }) {
    if (options?.maxHistory !== undefined) {
      this.maxHistory = options.maxHistory
    }
  }

  start(): void {
    if (this.inkInstance) return

    this.inkInstance = render(<TuiApp />, {
      // Use full terminal
    })
  }

  onRequestStart(request: TrackedRequest): void {
    tuiState.activeRequests.set(request.id, { ...request })
    notifyListeners()
  }

  onRequestUpdate(id: string, update: RequestUpdate): void {
    const request = tuiState.activeRequests.get(id)
    if (!request) return

    Object.assign(request, update)
    notifyListeners()
  }

  onRequestComplete(request: TrackedRequest): void {
    tuiState.activeRequests.delete(request.id)

    const isError =
      request.status === "error" || (request.statusCode ?? 0) >= 400

    if (isError) {
      tuiState.errorRequests.push({ ...request })
      // Trim error history
      while (tuiState.errorRequests.length > this.maxHistory) {
        tuiState.errorRequests.shift()
      }
    }

    tuiState.completedRequests.push({ ...request })
    // Trim completed history
    while (tuiState.completedRequests.length > this.maxHistory) {
      tuiState.completedRequests.shift()
    }

    notifyListeners()
  }

  destroy(): void {
    if (this.inkInstance) {
      this.inkInstance.unmount()
      this.inkInstance = null
    }
    tuiState.activeRequests.clear()
    tuiState.completedRequests = []
    tuiState.errorRequests = []
  }
}
