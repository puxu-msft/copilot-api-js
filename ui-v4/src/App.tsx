import type { RouteObject } from "react-router-dom"

import {
  //
  createHashRouter,
  Navigate,
} from "react-router-dom"

import { ConfigPage } from "@/components/config/ConfigPage"
import { LearnedPage } from "@/components/learned/LearnedPage"
import { ModelsPage } from "@/components/models/ModelsPage"
import { OverviewPage } from "@/components/overview/OverviewPage"
import { RequestDetailPage } from "@/components/requests/RequestDetailPage"
import { RequestsListPage } from "@/components/requests/RequestsListPage"
import { SessionDetailPage } from "@/components/sessions/SessionDetailPage"
import { SessionsPage } from "@/components/sessions/SessionsPage"
import { AppShell } from "@/components/shell/AppShell"
import { NotBuiltYet } from "@/components/shell/NotBuiltYet"
import { RouteError } from "@/components/shell/RouteError"
import { JsonToolsPage } from "@/components/tools/JsonToolsPage"

// 路由表单独导出:供默认路由守卫测试用 `createMemoryRouter(routes, ...)` 确定性地
// 断言 index → /overview(决策 6),而不必依赖 hash 历史。
export const routes: Array<RouteObject> = [
  {
    path: "/",
    element: <AppShell />,
    errorElement: <RouteError />,
    children: [
      {
        index: true,
        element: (
          <Navigate
            to="/overview"
            replace
          />
        ),
      },
      { path: "requests", element: <RequestsListPage /> },
      { path: "requests/:id", element: <RequestDetailPage /> },
      { path: "overview", element: <OverviewPage /> },
      { path: "models", element: <ModelsPage /> },
      { path: "config", element: <ConfigPage /> },
      { path: "learned", element: <LearnedPage /> },
      { path: "tools/json", element: <JsonToolsPage /> },
      { path: "sessions", element: <SessionsPage /> },
      { path: "sessions/:id", element: <SessionDetailPage /> },
      { path: "*", element: <NotBuiltYet /> },
    ],
  },
]

export const router = createHashRouter(routes)
