import {
  //
  createRouter,
  createWebHashHistory,
} from "vue-router"

import { resolveRouterBase } from "@/utils/router-base"

const router = createRouter({
  history: createWebHashHistory(resolveRouterBase(import.meta.env.BASE_URL)),
  scrollBehavior(_to, _from, savedPosition) {
    if (savedPosition) return savedPosition
    return { top: 0 }
  },
  routes: [
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
    { path: "/v/history/:id", redirect: (to) => `/activity/${String(to.params.id)}` },
    { path: "/v/config", redirect: "/config" },
    { path: "/v/models", redirect: "/models" },
    { path: "/v/usage", redirect: "/dashboard" },
    { path: "/v/logs", redirect: "/activity" },
    { path: "/history", redirect: "/activity" },
    { path: "/logs", redirect: "/activity" },
    { path: "/usage", redirect: "/dashboard" },
    // 404 catch-all
    { path: "/:pathMatch(.*)*", name: "not-found", redirect: "/dashboard" },
  ],
})

export default router
