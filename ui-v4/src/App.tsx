import {
  //
  createHashRouter,
  Navigate,
} from "react-router-dom"

import { ConfigPage } from "@/components/config/ConfigPage"
import { ModelsPage } from "@/components/models/ModelsPage"
import { OverviewPage } from "@/components/overview/OverviewPage"
import { RequestsWorkbench } from "@/components/requests/RequestsWorkbench"
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
      { path: "requests", element: <RequestsWorkbench /> },
      { path: "requests/:id", element: <RequestsWorkbench /> },
      { path: "overview", element: <OverviewPage /> },
      { path: "models", element: <ModelsPage /> },
      { path: "config", element: <ConfigPage /> },
      { path: "*", element: <NotBuiltYet /> },
    ],
  },
])
