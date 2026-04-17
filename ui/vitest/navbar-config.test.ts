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
      { path: "/activity", component: { template: "<div />" } },
      { path: "/activity/:id", component: { template: "<div />" } },
      { path: "/config", component: { template: "<div />" } },
      { path: "/models", component: { template: "<div />" } },
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

describe("NavBar", () => {
  it("renders all nav tabs including Config", async () => {
    const wrapper = await mountNavBarAt("/config")
    const labels = wrapper.findAll('[data-testid="v-tab"]').map((node) => node.text())

    expect(labels).toEqual(["Dashboard", "Config", "Models", "Activity"])
    expect(wrapper.find('[data-testid="v-app-bar"]').exists()).toBe(true)
    expect(wrapper.text()).toContain("System")
  })

  it("selects Activity tab for detail routes", async () => {
    const wrapper = await mountNavBarAt("/activity/req_123")

    expect(wrapper.get('[data-testid="v-tabs"]').attributes("data-model-value")).toBe("/activity")
  })

  it("selects Dashboard tab on /dashboard", async () => {
    const wrapper = await mountNavBarAt("/dashboard")

    expect(wrapper.get('[data-testid="v-tabs"]').attributes("data-model-value")).toBe("/dashboard")
  })

  it("renders theme toggle with system label", async () => {
    const wrapper = await mountNavBarAt("/dashboard")

    expect(wrapper.text()).toContain("System")
    expect(wrapper.find('[aria-label="Theme: System"]').exists()).toBe(true)
  })
})
