import { StyleProvider } from "@ant-design/cssinjs"
import {
  App as AntApp,
  Button,
  ConfigProvider,
  Descriptions,
  Space,
  Table,
  Tag,
  type TableColumnsType,
} from "antd"
import { useState } from "react"
import { Virtuoso } from "react-virtuoso"

import { themeByName, type PocThemeName } from "./amber-theme"

interface RequestRow {
  id: string
  model: string
  status: "ok" | "fail" | "slow"
  ms: number
}

const rows: RequestRow[] = Array.from({ length: 500 }, (_, i) => ({
  id: `req-${i}`,
  model: i % 2 ? "claude-opus-4-8" : "gpt-4.1",
  status: (["ok", "fail", "slow"] as const)[i % 3],
  ms: 100 + (i % 7) * 130,
}))

const statusColor: Record<RequestRow["status"], string> = {
  ok: "green",
  fail: "red",
  slow: "gold",
}

// 风险点 2：antd Table（自带虚拟能力之外的常规表格）用于中小静态表。
const columns: TableColumnsType<RequestRow> = [
  { title: "ID", dataIndex: "id", key: "id" },
  { title: "Model", dataIndex: "model", key: "model" },
  {
    title: "Status",
    dataIndex: "status",
    key: "status",
    render: (s: RequestRow["status"]) => <Tag color={statusColor[s]}>{s}</Tag>,
  },
  { title: "ms", dataIndex: "ms", key: "ms" },
]

/** 风险点 2 的关键验证：antd 视觉组件（Tag/Space）渲染进 react-virtuoso 的行里，
 *  证明"antd 出视觉 + virtuoso 出虚拟滚动"这条混用路径可行（6 处 virtuoso 场景必留）。 */
function VirtuosoAntdList() {
  return (
    <Virtuoso
      style={{ height: 240 }}
      data={rows}
      itemContent={(_index, row) => (
        // Tailwind class（flex/gap）与 antd 组件在同一行共存——风险点 3 的运行时侧。
        <div className="flex items-center gap-3 px-3 py-1" data-testid="virtuoso-antd-row">
          <span className="font-mono text-xs">{row.id}</span>
          <Tag color={statusColor[row.status]}>{row.status}</Tag>
          <span className="text-xs opacity-70">{row.model}</span>
        </div>
      )}
    />
  )
}

function Inner({ onThemeChange }: { onThemeChange: (t: PocThemeName) => void }) {
  // antd v6 最佳实践：用 App.useApp() 拿 context-aware 的 message/modal 实例
  // （能消费 ConfigProvider 主题；React 19 下渲染稳定）。静态 message 亦可用（PoC 探针已证），
  // 但 context 版是迁移应采用的惯用写法。
  const { message, modal } = AntApp.useApp()
  return (
    <div className="p-4">
      <Space className="mb-4">
        <Button type="primary" onClick={() => onThemeChange("blue")}>
          企业蓝白
        </Button>
        <Button onClick={() => onThemeChange("amber")}>Terminal Amber</Button>
        <Button
          data-testid="static-message-btn"
          onClick={() => {
            // 风险点 1：message 在 React 19 下渲染（antd v6 原生，无需 v5 补丁）。
            void message.success("static message ok")
          }}
        >
          触发 message
        </Button>
        <Button
          data-testid="static-modal-btn"
          onClick={() => {
            // 风险点 1：Modal.confirm 同样在 React 19 下工作。
            modal.confirm({ title: "confirm?", content: "static modal ok" })
          }}
        >
          触发 Modal
        </Button>
      </Space>

      <Descriptions title="Request" bordered size="small" column={2} className="mb-4">
        <Descriptions.Item label="Model">claude-opus-4-8</Descriptions.Item>
        <Descriptions.Item label="Status">
          <Tag color="green">ok</Tag>
        </Descriptions.Item>
      </Descriptions>

      <Table<RequestRow>
        rowKey="id"
        columns={columns}
        dataSource={rows.slice(0, 20)}
        pagination={false}
        size="small"
        className="mb-4"
      />

      <VirtuosoAntdList />
    </div>
  )
}

export function App() {
  const [themeName, setThemeName] = useState<PocThemeName>("blue")

  return (
    // StyleProvider hashPriority="high" 让 antd 样式用类选择器（提升特异性），
    // 与 Tailwind utility 争夺时行为可预期（风险点 3）。
    <StyleProvider hashPriority="high">
      <ConfigProvider theme={themeByName[themeName]}>
        <AntApp>
          <Inner onThemeChange={setThemeName} />
        </AntApp>
      </ConfigProvider>
    </StyleProvider>
  )
}
