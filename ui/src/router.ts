import {
  //
  createRouter,
  createWebHashHistory,
  type RouteRecordRaw,
} from "vue-router"

import { resolveRouterBase } from "@/utils/router-base"

/** Route table (exported for testing with an in-memory history). */
export const routes: Array<RouteRecordRaw> = [
  {
    path: "/",
    redirect: "/dashboard",
  },
  {
    path: "/dashboard",
    name: "dashboard",
    component: () => import("@/pages/vuetify/VDashboardPage.vue"),
  },
  {
    path: "/activity",
    name: "activity",
    component: () => import("@/pages/vuetify/VActivityPage.vue"),
  },
  {
    path: "/activity/:id",
    name: "activity-detail",
    component: () => import("@/pages/vuetify/VDetailPage.vue"),
  },
  {
    path: "/config",
    name: "config",
    component: () => import("@/pages/vuetify/VConfigPage.vue"),
  },
  {
    path: "/models",
    name: "models",
    component: () => import("@/pages/vuetify/VModelsPage.vue"),
  },
  // Legacy redirects (bookmarks, external links)
  { path: "/v/dashboard", redirect: "/dashboard" },
  { path: "/v/activity", redirect: "/activity" },
  { path: "/v/history", redirect: "/activity" },
  { path: "/v/history/:id", redirect: (to) => ({ name: "activity-detail", params: { id: String(to.params.id) }, query: to.query }) },
  { path: "/v/config", redirect: "/config" },
  { path: "/v/models", redirect: "/models" },
  { path: "/v/usage", redirect: "/dashboard" },
  { path: "/v/logs", redirect: "/activity" },
  { path: "/history", redirect: "/activity" },
  { path: "/logs", redirect: "/activity" },
  { path: "/usage", redirect: "/dashboard" },
  // 404 catch-all
  { path: "/:pathMatch(.*)*", name: "not-found", redirect: "/dashboard" },
]

const router = createRouter({
  history: createWebHashHistory(resolveRouterBase(import.meta.env.BASE_URL)),
  // No scrollBehavior: pages scroll inside their own `.v-page-scroll` /
  // `.detail-body` containers, not the window — a window-level scrollBehavior
  // would be a no-op. List scroll position is preserved by <keep-alive> on the
  // Activity route (see App.vue).
  routes,
})

export default router
