import type { Model } from "~backend/lib/models/client"

import {
  //
  Chip,
  renderValue,
  Row,
  Section,
} from "@/components/models/detail-tabs/DetailParts"

/**
 * Limits + Vision tab. Reads raw `capabilities.limits` (exact integers, not the
 * compacted table view). The Vision block is CONDITIONAL — rendered only when
 * `capabilities.limits.vision` exists (these fields are not on DerivedCapabilities;
 * read straight from raw).
 */
export function LimitsVisionTab({ model }: { model: Model }) {
  const limits = model.capabilities?.limits
  const vision = limits?.vision

  return (
    <div>
      <Section title="Token limits">
        <Row
          label="max_context_window_tokens"
          value={limits?.max_context_window_tokens}
        />
        <Row
          label="max_prompt_tokens"
          value={limits?.max_prompt_tokens}
        />
        <Row
          label="max_output_tokens"
          value={limits?.max_output_tokens}
        />
        <Row
          label="max_non_streaming_output_tokens"
          value={limits?.max_non_streaming_output_tokens}
        />
        <Row
          label="max_inputs"
          value={limits?.max_inputs}
        />
      </Section>

      {vision ?
        <Section title="Vision">
          <Row
            label="max_prompt_images"
            value={vision.max_prompt_images}
          />
          <Row
            label="max_prompt_image_size"
            value={vision.max_prompt_image_size}
          />
          <Row label="supported_media_types">
            {vision.supported_media_types && vision.supported_media_types.length > 0 ?
              vision.supported_media_types.map((t) => <Chip key={t}>{t}</Chip>)
            : renderValue(undefined)}
          </Row>
        </Section>
      : null}
    </div>
  )
}
