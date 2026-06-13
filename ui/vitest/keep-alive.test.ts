import { mount } from "@vue/test-utils"
import {
  //
  describe,
  expect,
  test,
} from "vitest"
import {
  //
  defineComponent,
  h,
  onActivated,
  onMounted,
} from "vue"
import {
  //
  createMemoryHistory,
  createRouter,
  type Router,
} from "vue-router"

// Replicates App.vue's router-view: <keep-alive include="VActivityPage">.
const Shell = defineComponent({
  name: "AppShell",
  template: `<router-view v-slot="{ Component }"><keep-alive include="VActivityPage"><component :is="Component" /></keep-alive></router-view>`,
})

let activityMounts = 0
let activityActivations = 0
let detailMounts = 0

// The Activity route component MUST be named "VActivityPage" for keep-alive include to match.
const ActivityStub = defineComponent({
  name: "VActivityPage",
  setup() {
    onMounted(() => activityMounts++)
    onActivated(() => activityActivations++)
    return () => h("div", "activity-list")
  },
})
const DetailStub = defineComponent({
  name: "VDetailPage",
  setup() {
    onMounted(() => detailMounts++)
    return () => h("div", "detail")
  },
})

function makeRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/activity", name: "activity", component: ActivityStub },
      { path: "/activity/:id", name: "activity-detail", component: DetailStub },
    ],
  })
}

describe("keep-alive list ↔ detail ↔ back", () => {
  test("Activity list is cached (mounted once) across a detail round-trip; detail re-mounts each visit", async () => {
    activityMounts = 0
    activityActivations = 0
    detailMounts = 0
    const router = makeRouter()
    await router.push("/activity")
    await router.isReady()
    mount(Shell, { global: { plugins: [router] } })
    await router.isReady()

    expect(activityMounts).toBe(1)
    expect(activityActivations).toBe(1)

    // Go to detail → activity deactivated (NOT unmounted), detail mounts.
    await router.push({ name: "activity-detail", params: { id: "a" } })
    expect(detailMounts).toBe(1)
    expect(activityMounts).toBe(1) // still cached, not re-mounted

    // Back to list → activity ACTIVATED (not re-mounted).
    await router.push("/activity")
    expect(activityMounts).toBe(1) // proves keep-alive caching (would be 2 if include mismatched)
    expect(activityActivations).toBe(2)

    // Visit another detail → detail re-mounts (NOT cached).
    await router.push({ name: "activity-detail", params: { id: "b" } })
    expect(detailMounts).toBe(2)
  })
})
