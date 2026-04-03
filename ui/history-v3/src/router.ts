import { createRouter, createWebHashHistory } from "vue-router"
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
      redirect: "/v/dashboard",
    },
    // @deprecated Legacy routes are maintenance-only. Prefer /v/* Vuetify routes.
    {
      path: "/history",
      redirect: "/v/activity",
    },
    {
      path: "/logs",
      name: "logs",
      component: () => import("@/pages/LogsPage.vue"),
    },
    {
      path: "/dashboard",
      name: "dashboard",
      redirect: "/v/dashboard",
    },
    {
      path: "/models",
      name: "models",
      redirect: "/v/models",
    },
    {
      path: "/usage",
      name: "usage",
      redirect: "/v/dashboard",
    },
    // Canonical Vuetify routes
    {
      path: "/v/history",
      redirect: "/v/activity",
    },
    {
      path: "/v/history/:id",
      name: "v-history-detail",
      component: () => import("@/pages/vuetify/VActivityPage.vue"),
    },
    {
      path: "/v/logs",
      redirect: "/v/activity",
    },
    {
      path: "/v/activity",
      name: "v-activity",
      component: () => import("@/pages/vuetify/VActivityPage.vue"),
    },
    {
      path: "/v/dashboard",
      name: "v-dashboard",
      component: () => import("@/pages/vuetify/VDashboardPage.vue"),
    },
    {
      path: "/v/config",
      name: "v-config",
      component: () => import("@/pages/vuetify/VConfigPage.vue"),
    },
    {
      path: "/v/models",
      name: "v-models",
      component: () => import("@/pages/vuetify/VModelsPage.vue"),
    },
    {
      path: "/v/usage",
      redirect: "/v/dashboard",
    },
  ],
})

export default router
