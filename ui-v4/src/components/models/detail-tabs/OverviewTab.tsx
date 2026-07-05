import type { Model } from "~backend/lib/models/client"

import { getEffectiveEndpoints } from "~backend/lib/models/endpoint"

import {
  //
  Chip,
  renderValue,
  Row,
  Section,
} from "@/components/models/detail-tabs/DetailParts"

/**
 * Overview tab: identity + picker/default flags + effective endpoints.
 *
 * Endpoints fold in here (spec §6, no separate tab). `getEffectiveEndpoints`
 * returns `supported_endpoints` verbatim when present, else infers from
 * `capabilities.type` for legacy models — inferred lists are tagged `(inferred)`
 * so an upstream-declared endpoint is distinguishable from a frontend guess.
 */
export function OverviewTab({ model }: { model: Model }) {
  const endpoints = getEffectiveEndpoints(model)
  const inferred = !model.supported_endpoints

  return (
    <div>
      <Section title="Identity">
        <Row
          label="id"
          value={model.id}
        />
        <Row
          label="name"
          value={model.name}
        />
        <Row
          label="vendor"
          value={model.vendor}
        />
        <Row
          label="version"
          value={model.version}
        />
        <Row
          label="family"
          value={model.capabilities?.family}
        />
        <Row
          label="tokenizer"
          value={model.capabilities?.tokenizer}
        />
        <Row
          label="type"
          value={model.capabilities?.type}
        />
        <Row
          label="object"
          value={model.capabilities?.object}
        />
      </Section>

      <Section title="Picker & defaults">
        <Row
          label="model_picker_category"
          value={model.model_picker_category}
        />
        <Row
          label="model_picker_enabled"
          value={model.model_picker_enabled}
        />
        <Row
          label="is_chat_default"
          value={model.is_chat_default}
        />
        <Row
          label="is_chat_fallback"
          value={model.is_chat_fallback}
        />
        <Row
          label="preview"
          value={model.preview}
        />
      </Section>

      <Section title="Endpoints">
        <Row label={inferred ? "endpoints (inferred)" : "endpoints"}>
          {endpoints && endpoints.length > 0 ?
            <span>
              {endpoints.map((e) => (
                <Chip key={e}>{e}</Chip>
              ))}
              {inferred ?
                <span className="ml-1 text-[10px] text-[var(--color-muted)]">inferred from capabilities.type</span>
              : null}
            </span>
          : renderValue(undefined)}
        </Row>
      </Section>
    </div>
  )
}
