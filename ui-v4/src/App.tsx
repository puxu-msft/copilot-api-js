import {
  //
  createHashRouter,
  Navigate,
} from "react-router-dom"

import { ConfigPage } from "@/components/config/ConfigPage"
import { ModelsPage } from "@/components/models/ModelsPage"
import { OverviewPage } from "@/components/overview/OverviewPage"
import { RequestDetailPage } from "@/components/requests/RequestDetailPage"
import { RequestsListPage } from "@/components/requests/RequestsListPage"
import { SessionDetailPage } from "@/components/sessions/SessionDetailPage"
import { SessionsPage } from "@/components/sessions/SessionsPage"
import { AppShell } from "@/components/shell/AppShell"
import { NotBuiltYet } from "@/components/shell/NotBuiltYet"
import { RouteError } from "@/components/shell/RouteError"

export const router = createHashRouter([
  {
    path: "/",
    element: <AppShell />,
    errorElement: <RouteError />,
    children: [
      {
        index: true,
        element: (
          <Navigate
            to="/requests"
            replace
          />
        ),
      },
      { path: "requests", element: <RequestsListPage /> },
      { path: "requests/:id", element: <RequestDetailPage /> },
      { path: "overview", element: <OverviewPage /> },
      { path: "models", element: <ModelsPage /> },
      { path: "config", element: <ConfigPage /> },
      { path: "sessions", element: <SessionsPage /> },
      { path: "sessions/:id", element: <SessionDetailPage /> },
      { path: "*", element: <NotBuiltYet /> },
    ],
  },
])
