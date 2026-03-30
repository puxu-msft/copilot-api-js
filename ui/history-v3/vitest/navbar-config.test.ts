import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import { ref } from "vue"
import { createMemoryHistory, createRouter } from "vue-router"

import NavBar from "@/components/layout/NavBar.vue"

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/dashboard", component: { template: "<div />" } },
      { path: "/history", component: { template: "<div />" } },
      { path: "/v/dashboard", component: { template: "<div />" } },
      { path: "/v/history", component: { template: "<div />" } },
      { path: "/v/config", component: { template: "<div />" } },
      { path: "/v/models", component: { template: "<div />" } },
      { path: "/v/logs", component: { template: "<div />" } },
      { path: "/v/usage", component: { template: "<div />" } },
      { path: "/models", component: { template: "<div />" } },
      { path: "/logs", component: { template: "<div />" } },
      { path: "/usage", component: { template: "<div />" } },
    ],
  })
}

async function mountNavBarAt(path: string) {
  const router = makeRouter()
  await router.push(path)
  await router.isReady()

  return mount(NavBar, {
    global: {
      plugins: [router],
      provide: {
        historyStore: {
          wsConnected: ref(true),
        },
      },
    },
  })
}

describe("NavBar config route integration", () => {
  it("shows Config in Vuetify mode immediately after Dashboard and hides the variant switch on /v/config", async () => {
    const wrapper = await mountNavBarAt("/v/config")
    const labels = wrapper.findAll(".navbar-center a").map((node) => node.text())

    expect(labels).toEqual(["Dashboard", "Config", "Models", "Logs", "History", "Usage"])
    expect(wrapper.find(".switch-link").exists()).toBe(false)
  })

  it("does not show Config in legacy mode", async () => {
    const wrapper = await mountNavBarAt("/history")
    const labels = wrapper.findAll(".navbar-center a").map((node) => node.text())

    expect(labels).toEqual(["Dashboard", "Models", "Logs", "History", "Usage"])
    expect(labels).not.toContain("Config")
    expect(wrapper.find(".switch-link").exists()).toBe(true)
  })
})
