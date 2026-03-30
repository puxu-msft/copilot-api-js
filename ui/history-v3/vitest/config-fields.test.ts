import { describe, expect, it } from "vitest"

import ConfigEnum from "@/components/config/ConfigEnum.vue"
import ConfigKeyValueList from "@/components/config/ConfigKeyValueList.vue"
import ConfigNumber from "@/components/config/ConfigNumber.vue"
import ConfigRewriteRules from "@/components/config/ConfigRewriteRules.vue"
import ConfigSection from "@/components/config/ConfigSection.vue"
import ConfigText from "@/components/config/ConfigText.vue"
import ConfigToggle from "@/components/config/ConfigToggle.vue"

import { mountWithVuetifyStubs, VBtnToggleStub, VSelectStub } from "./helpers/mount"

describe("config field components", () => {
  it("ConfigToggle supports label, disabled, and v-model updates", async () => {
    const wrapper = mountWithVuetifyStubs(ConfigToggle, {
      props: {
        modelValue: false,
        label: "Strip Server Tools",
        description: "desc",
        disabled: true,
      },
    })

    expect(wrapper.text()).toContain("Strip Server Tools")
    expect(wrapper.text()).toContain("desc")

    const input = wrapper.get('input[type="checkbox"]')
    expect(input.attributes("disabled")).toBeDefined()

    await wrapper.setProps({ disabled: false })
    await input.setValue(true)

    expect(wrapper.emitted("update:modelValue")).toEqual([[true]])
  })

  it("ConfigNumber supports suffix, min, and nullable number updates", async () => {
    const wrapper = mountWithVuetifyStubs(ConfigNumber, {
      props: {
        modelValue: 300,
        label: "Fetch Timeout",
        suffix: "s",
        min: 0,
      },
    })

    const input = wrapper.get('input[type="number"]')
    expect(input.attributes("min")).toBe("0")
    expect(wrapper.text()).toContain("s")

    await input.setValue("600")
    await input.setValue("")

    expect(wrapper.emitted("update:modelValue")).toEqual([[600], [null]])
  })

  it("ConfigEnum renders options and forwards toggle updates", () => {
    const wrapper = mountWithVuetifyStubs(ConfigEnum, {
      props: {
        modelValue: false,
        label: "Dedup Tool Calls",
        options: [
          { value: false, label: "Off" },
          { value: "input", label: "Input" },
        ],
      },
    })

    expect(wrapper.text()).toContain("Off")
    expect(wrapper.text()).toContain("Input")
    expect(wrapper.get('[data-testid="v-btn-toggle"]').attributes("data-model-value")).toBe("false")

    wrapper.getComponent(VBtnToggleStub).vm.$emit("update:modelValue", "input")

    expect(wrapper.emitted("update:modelValue")).toEqual([["input"]])
  })

  it("ConfigText supports single-line and multiline input updates", async () => {
    const singleLine = mountWithVuetifyStubs(ConfigText, {
      props: {
        modelValue: "http://127.0.0.1:7890",
        label: "Proxy",
      },
    })

    const singleInput = singleLine.get('input[type="text"]')
    await singleInput.setValue("http://localhost:8080")
    await singleInput.setValue("")

    expect(singleLine.emitted("update:modelValue")).toEqual([["http://localhost:8080"], [null]])

    const multiline = mountWithVuetifyStubs(ConfigText, {
      props: {
        modelValue: "prepend",
        label: "System Prompt Prepend",
        multiline: true,
      },
    })

    const textarea = multiline.get("textarea")
    await textarea.setValue("updated")

    expect(multiline.emitted("update:modelValue")).toEqual([["updated"]])
  })

  it("ConfigKeyValueList supports add, edit, remove, and empty state", async () => {
    const emptyWrapper = mountWithVuetifyStubs(ConfigKeyValueList, {
      props: {
        modelValue: [],
        label: "Overrides",
      },
    })
    expect(emptyWrapper.text()).toContain("No overrides configured.")

    const wrapper = mountWithVuetifyStubs(ConfigKeyValueList, {
      props: {
        modelValue: [{ key: "claude", value: "claude-sonnet" }],
        label: "Overrides",
      },
    })

    const addOverrideButton = wrapper.findAll("button").find((node) => node.text().includes("Add override"))
    if (!addOverrideButton) {
      throw new Error("Add override button missing")
    }
    await addOverrideButton.trigger("click")
    expect(wrapper.emitted("update:modelValue")?.[0]).toEqual([
      [
        { key: "claude", value: "claude-sonnet" },
        { key: "", value: "" },
      ],
    ])

    const inputs = wrapper.findAll("input")
    await inputs[0].setValue("gpt-4")
    expect(wrapper.emitted("update:modelValue")?.[1]).toEqual([[{ key: "gpt-4", value: "claude-sonnet" }]])

    await wrapper.findAll("button")[0].trigger("click")
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual([[]])
  })

  it("ConfigRewriteRules supports mode switching, add/remove, method change, and optional model field", async () => {
    const modeWrapper = mountWithVuetifyStubs(ConfigRewriteRules, {
      props: {
        modelValue: false,
        label: "Rewrite System Reminders",
        allowBooleanModes: true,
      },
    })

    expect(modeWrapper.text()).toContain("Rules are disabled.")
    modeWrapper.getComponent(VBtnToggleStub).vm.$emit("update:modelValue", "rules")
    expect(modeWrapper.emitted("update:modelValue")?.[0]).toEqual([[]])

    const rulesWrapper = mountWithVuetifyStubs(ConfigRewriteRules, {
      props: {
        modelValue: [{ from: "foo", to: "bar", method: "regex", model: "claude" }],
        label: "System Prompt Overrides",
        allowBooleanModes: true,
        showModelField: true,
      },
    })

    expect(rulesWrapper.text()).toContain("Rule 1")
    expect(rulesWrapper.find('input[data-label="Model regex"]').exists()).toBe(true)
    expect(rulesWrapper.get('[data-testid="rule-summary"]').text()).toContain("regex")

    const toggleRuleButton = rulesWrapper.findAll('button[data-testid="toggle-rule"]')[0]
    await toggleRuleButton.trigger("click")
    expect(rulesWrapper.get('[data-testid="collapsed-rule-summary"]').text()).toContain("foo")
    expect(rulesWrapper.find('input[data-label="Model regex"]').exists()).toBe(false)

    await toggleRuleButton.trigger("click")
    expect(rulesWrapper.find('input[data-label="Model regex"]').exists()).toBe(true)

    rulesWrapper.getComponent(VSelectStub).vm.$emit("update:modelValue", "line")
    expect(rulesWrapper.emitted("update:modelValue")?.[0]).toEqual([
      [{ from: "foo", to: "bar", method: "line", model: "claude" }],
    ])

    const addRuleButton = rulesWrapper.findAll("button").find((node) => node.text().includes("Add rule"))
    if (!addRuleButton) {
      throw new Error("Add rule button missing")
    }
    await addRuleButton.trigger("click")
    expect(rulesWrapper.emitted("update:modelValue")?.[1]).toEqual([
      [
        { from: "foo", to: "bar", method: "regex", model: "claude" },
        { from: "", to: "", method: "regex" },
      ],
    ])

    const removeWrapper = mountWithVuetifyStubs(ConfigRewriteRules, {
      props: {
        modelValue: [{ from: "foo", to: "bar", method: "regex" }],
        label: "Rewrite System Reminders",
        allowBooleanModes: true,
      },
    })

    await removeWrapper.get('button[data-icon="mdi-delete-outline"]').trigger("click")
    expect(removeWrapper.emitted("update:modelValue")?.[0]).toEqual([false])
  })

  it("ConfigSection renders title, description, restart badge, and tooltip copy", () => {
    const wrapper = mountWithVuetifyStubs(ConfigSection, {
      props: {
        title: "General",
        description: "Top-level transport settings.",
        requiresRestart: true,
      },
    })

    expect(wrapper.text()).toContain("General")
    expect(wrapper.text()).toContain("Top-level transport settings.")
    expect(wrapper.text()).toContain("Requires restart")
    expect(wrapper.text()).toContain("Requires restart to take effect")
  })
})
