import { mount, type ComponentMountingOptions } from "@vue/test-utils"
import { defineComponent, h, type Component, type VNode } from "vue"

function slotChildren(children: Array<VNode> | undefined): Array<VNode> {
  return children ?? []
}

function slotContent(children: VNode | Array<VNode> | undefined): Array<VNode> {
  if (!children) {
    return []
  }

  return Array.isArray(children) ? children : [children]
}

export const VCardStub = defineComponent({
  name: "VCardStub",
  setup(_, { slots }) {
    return () => h("section", { "data-testid": "v-card" }, slotChildren(slots.default?.()))
  },
})

export const VCardTitleStub = defineComponent({
  name: "VCardTitleStub",
  setup(_, { slots }) {
    return () => h("div", { "data-testid": "v-card-title" }, slotChildren(slots.default?.()))
  },
})

export const VCardTextStub = defineComponent({
  name: "VCardTextStub",
  setup(_, { slots }) {
    return () => h("div", { "data-testid": "v-card-text" }, slotChildren(slots.default?.()))
  },
})

export const VDividerStub = defineComponent({
  name: "VDividerStub",
  setup() {
    return () => h("hr", { "data-testid": "v-divider" })
  },
})

export const VChipStub = defineComponent({
  name: "VChipStub",
  setup(_, { slots }) {
    return () => h("div", { "data-testid": "v-chip" }, slotChildren(slots.default?.()))
  },
})

export const VTooltipStub = defineComponent({
  name: "VTooltipStub",
  setup(_, { slots }) {
    return () =>
      h("div", { "data-testid": "v-tooltip" }, [
        ...slotContent(slots.activator?.({ props: {} })),
        ...slotChildren(slots.default?.()),
      ])
  },
})

export const VIconStub = defineComponent({
  name: "VIconStub",
  props: {
    icon: {
      type: String,
      default: "",
    },
  },
  setup(props) {
    return () => h("i", { "data-testid": "v-icon" }, props.icon)
  },
})

export const VAlertStub = defineComponent({
  name: "VAlertStub",
  setup(_, { slots }) {
    return () => h("div", { role: "alert", "data-testid": "v-alert" }, slotChildren(slots.default?.()))
  },
})

export const VProgressCircularStub = defineComponent({
  name: "VProgressCircularStub",
  setup() {
    return () => h("div", { "data-testid": "v-progress-circular" }, "Loading")
  },
})

export const VSpacerStub = defineComponent({
  name: "VSpacerStub",
  setup() {
    return () => h("div", { "data-testid": "v-spacer" })
  },
})

export const VBtnStub = defineComponent({
  name: "VBtnStub",
  props: {
    disabled: Boolean,
    loading: Boolean,
    icon: {
      type: String,
      default: "",
    },
  },
  emits: ["click"],
  setup(props, { slots, emit }) {
    return () =>
      h(
        "button",
        {
          type: "button",
          disabled: props.disabled,
          "data-loading": String(props.loading),
          "data-icon": props.icon,
          onClick: (event: MouseEvent) => emit("click", event),
        },
        slotChildren(slots.default?.()),
      )
  },
})

export const VTextFieldStub = defineComponent({
  name: "VTextFieldStub",
  props: {
    modelValue: {
      type: [String, Number, Boolean],
      default: "",
    },
    disabled: Boolean,
    label: {
      type: String,
      default: "",
    },
    placeholder: {
      type: String,
      default: "",
    },
    type: {
      type: String,
      default: "text",
    },
    suffix: {
      type: String,
      default: "",
    },
    min: {
      type: [String, Number],
      default: undefined,
    },
    max: {
      type: [String, Number],
      default: undefined,
    },
    error: Boolean,
  },
  emits: ["update:modelValue"],
  setup(props, { emit }) {
    return () =>
      h("label", { "data-testid": "v-text-field", "data-label": props.label }, [
        props.label ? h("span", props.label) : null,
        h("input", {
          value: String(props.modelValue),
          disabled: props.disabled,
          placeholder: props.placeholder,
          type: props.type,
          min: props.min,
          max: props.max,
          "data-label": props.label,
          "data-error": String(props.error),
          onInput: (event: Event) => emit("update:modelValue", (event.target as HTMLInputElement).value),
        }),
        props.suffix ? h("span", props.suffix) : null,
      ])
  },
})

export const VTextareaStub = defineComponent({
  name: "VTextareaStub",
  props: {
    modelValue: {
      type: String,
      default: "",
    },
    disabled: Boolean,
    label: {
      type: String,
      default: "",
    },
    placeholder: {
      type: String,
      default: "",
    },
  },
  emits: ["update:modelValue"],
  setup(props, { emit }) {
    return () =>
      h("label", { "data-testid": "v-textarea", "data-label": props.label }, [
        props.label ? h("span", props.label) : null,
        h("textarea", {
          value: props.modelValue,
          disabled: props.disabled,
          placeholder: props.placeholder,
          "data-label": props.label,
          onInput: (event: Event) => emit("update:modelValue", (event.target as HTMLTextAreaElement).value),
        }),
      ])
  },
})

export const VSwitchStub = defineComponent({
  name: "VSwitchStub",
  props: {
    modelValue: Boolean,
    disabled: Boolean,
  },
  emits: ["update:modelValue"],
  setup(props, { emit }) {
    return () =>
      h("input", {
        type: "checkbox",
        checked: props.modelValue,
        disabled: props.disabled,
        "data-testid": "v-switch",
        onChange: (event: Event) => emit("update:modelValue", (event.target as HTMLInputElement).checked),
      })
  },
})

export const VBtnToggleStub = defineComponent({
  name: "VBtnToggleStub",
  props: {
    modelValue: {
      type: [String, Boolean],
      default: null,
    },
    disabled: Boolean,
  },
  emits: ["update:modelValue"],
  setup(props, { slots }) {
    return () =>
      h(
        "div",
        {
          "data-testid": "v-btn-toggle",
          "data-model-value": String(props.modelValue),
          "data-disabled": String(props.disabled),
        },
        slotChildren(slots.default?.()),
      )
  },
})

export const VSelectStub = defineComponent({
  name: "VSelectStub",
  props: {
    modelValue: {
      type: [String, Boolean],
      default: "",
    },
    disabled: Boolean,
    label: {
      type: String,
      default: "",
    },
    items: {
      type: Array as () => Array<{ title: string; value: string }>,
      default: () => [],
    },
  },
  emits: ["update:modelValue"],
  setup(props, { emit }) {
    return () =>
      h("label", { "data-testid": "v-select", "data-label": props.label }, [
        props.label ? h("span", props.label) : null,
        h(
          "select",
          {
            disabled: props.disabled,
            value: String(props.modelValue),
            "data-label": props.label,
            onChange: (event: Event) => emit("update:modelValue", (event.target as HTMLSelectElement).value),
          },
          props.items.map((item) => h("option", { key: item.value, value: item.value }, item.title)),
        ),
      ])
  },
})

export const vuetifyComponentStubs = {
  VAlert: VAlertStub,
  VBtn: VBtnStub,
  VBtnToggle: VBtnToggleStub,
  VCard: VCardStub,
  VCardText: VCardTextStub,
  VCardTitle: VCardTitleStub,
  VChip: VChipStub,
  VDivider: VDividerStub,
  VIcon: VIconStub,
  VProgressCircular: VProgressCircularStub,
  VSelect: VSelectStub,
  VSpacer: VSpacerStub,
  VSwitch: VSwitchStub,
  VTextarea: VTextareaStub,
  VTextField: VTextFieldStub,
  VTooltip: VTooltipStub,
}

export function mountWithVuetifyStubs<T extends Component>(component: T, options: ComponentMountingOptions<T> = {}) {
  const globalOptions = options.global ?? {}
  const components = Object.assign({}, vuetifyComponentStubs, globalOptions.components)

  return mount(component, {
    ...options,
    global: {
      ...globalOptions,
      components,
    },
  } as never)
}
