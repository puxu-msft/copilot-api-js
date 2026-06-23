import {
  //
  createHashRouter,
  Navigate,
} from "react-router-dom"

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
      { path: "*", element: <NotBuiltYet /> },
    ],
  },
])
