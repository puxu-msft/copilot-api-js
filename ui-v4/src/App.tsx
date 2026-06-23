import {
  //
  createHashRouter,
  Navigate,
} from "react-router-dom"

import { RequestsListPage } from "@/components/requests/RequestsListPage"
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
      { path: "requests/:id", element: <RequestsListPage /> },
      { path: "*", element: <NotBuiltYet /> },
    ],
  },
])
