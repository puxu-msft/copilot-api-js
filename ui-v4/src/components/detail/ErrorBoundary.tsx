import {
  //
  Component,
  type ErrorInfo,
  type ReactNode,
} from "react"

interface ErrorBoundaryProps {
  label?: string
  children: ReactNode
}
interface ErrorBoundaryState {
  error: Error | null
}

/** 块级错误边界 —— 单个块渲染失败不拖垮整个详情(spec §9 块包 ErrorBoundary)。 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }
  override componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // 静默兜底;详情诊断价值在不崩,不上报
  }
  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="mono border border-[var(--signal-fail)] px-2 py-1 text-[13px] text-[var(--signal-fail)]">
          ⚠ {this.props.label ?? "block"} 渲染失败:{this.state.error.message}
        </div>
      )
    }
    return this.props.children
  }
}
