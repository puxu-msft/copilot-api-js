import { createRouter, createWebHashHistory } from "vue-router"

const router = createRouter({
  history: createWebHashHistory("/ui/"),
  routes: [
    {
      path: "/",
      redirect: "/v/dashboard",
    },
    // @deprecated Legacy routes are maintenance-only. Prefer /v/* Vuetify routes.
    {
      path: "/history",
      name: "history",
      component: () => import("@/pages/HistoryPage.vue"),
    },
    {
      path: "/logs",
      name: "logs",
      component: () => import("@/pages/LogsPage.vue"),
    },
    {
      path: "/dashboard",
      name: "dashboard",
      component: () => import("@/pages/DashboardPage.vue"),
    },
    {
      path: "/models",
      name: "models",
      component: () => import("@/pages/ModelsPage.vue"),
    },
    {
      path: "/usage",
      name: "usage",
      component: () => import("@/pages/UsagePage.vue"),
    },
    // Canonical Vuetify routes
    {
      path: "/v/history",
      name: "v-history",
      component: () => import("@/pages/vuetify/VHistoryPage.vue"),
    },
    {
      path: "/v/logs",
      name: "v-logs",
      component: () => import("@/pages/vuetify/VLogsPage.vue"),
    },
    {
      path: "/v/dashboard",
      name: "v-dashboard",
      component: () => import("@/pages/vuetify/VDashboardPage.vue"),
    },
    {
      path: "/v/models",
      name: "v-models",
      component: () => import("@/pages/vuetify/VModelsPage.vue"),
    },
    {
      path: "/v/usage",
      name: "v-usage",
      component: () => import("@/pages/vuetify/VUsagePage.vue"),
    },
  ],
})

export default router
