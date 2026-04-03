import { mount } from "@vue/test-utils"
import { describe, expect, it, vi } from "vitest"
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
      { path: "/v/history/:id", component: { template: "<div />" } },
      { path: "/v/config", component: { template: "<div />" } },
      { path: "/v/models", component: { template: "<div />" } },
      { path: "/v/activity", component: { template: "<div />" } },
      { path: "/logs", component: { template: "<div />" } },
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
        appTheme: {
          cycle: vi.fn(),
          isDark: vi.fn(() => true),
          name: vi.fn(() => "system"),
          theme: {
            global: {
              current: ref({ dark: true }),
              name: ref("system"),
            },
          },
        },
      },
      stubs: {
        "v-app-bar": { template: '<header data-testid="v-app-bar"><slot /></header>' },
        "v-app-bar-title": { template: '<div data-testid="v-app-bar-title"><slot /></div>' },
        "v-btn": {
          props: ["icon"],
          template: '<button type="button" data-testid="v-btn"><slot /></button>',
        },
        "v-chip": { template: '<div data-testid="v-chip"><slot /></div>' },
        "v-icon": {
          props: ["icon"],
          template: '<i data-testid="v-icon">{{ icon }}<slot /></i>',
        },
        "v-spacer": { template: '<div data-testid="v-spacer" />' },
        "v-tabs": {
          props: ["modelValue"],
          template: '<div data-testid="v-tabs" :data-model-value="modelValue"><slot /></div>',
        },
        "v-tab": {
          props: ["to", "value"],
          template: '<a :href="to" data-testid="v-tab" :data-value="value"><slot /></a>',
        },
        "v-tooltip": { template: '<div data-testid="v-tooltip"><slot /></div>' },
      },
    },
  })
}

describe("NavBar config route integration", () => {
  it("shows Config in Vuetify mode immediately after Dashboard and renders the Vuetify shell on /v/config", async () => {
    const wrapper = await mountNavBarAt("/v/config")
    const labels = wrapper.findAll('[data-testid="v-tab"]').map((node) => node.text())

    expect(labels).toEqual(["Dashboard", "Config", "Models", "Activity"])
    expect(wrapper.find('[data-testid="v-app-bar"]').exists()).toBe(true)
    expect(wrapper.find(".switch-link").exists()).toBe(false)
    expect(wrapper.text()).toContain("System")
  })

  it("does not show Config in legacy mode", async () => {
    const wrapper = await mountNavBarAt("/logs")
    const labels = wrapper.findAll(".navbar-center a").map((node) => node.text())

    expect(labels).toEqual(["Logs"])
    expect(labels).not.toContain("Config")
    expect(wrapper.find(".switch-link").exists()).toBe(true)
    expect(wrapper.find(".navbar").exists()).toBe(true)
  })

  it("marks the current legacy route active via exact-active-class", async () => {
    const wrapper = await mountNavBarAt("/logs")

    expect(wrapper.get(".navbar-center a.active").text()).toBe("Logs")
  })

  it("shows the variant switch in Vuetify mode when a legacy counterpart exists", async () => {
    const wrapper = await mountNavBarAt("/v/activity")

    expect(wrapper.find('[data-testid="v-app-bar"]').exists()).toBe(true)
    expect(wrapper.text()).toContain("Legacy")
  })

  it("keeps Activity selected for history detail routes", async () => {
    const wrapper = await mountNavBarAt("/v/history/req_123")

    expect(wrapper.get('[data-testid="v-tabs"]').attributes("data-model-value")).toBe("/v/activity")
  })
})
