import type { Model } from "~backend/lib/models/client"

import {
  //
  Chip,
  renderValue,
  Row,
  Section,
} from "@/components/models/detail-tabs/DetailParts"

/** Billing + Policy tab: cost multiplier / premium / plan restrictions, and the model policy. */
export function BillingPolicyTab({ model }: { model: Model }) {
  const billing = model.billing
  const restricted = billing?.restricted_to ?? []
  const policy = model.policy

  return (
    <div>
      <Section title="Billing">
        <Row
          label="multiplier"
          value={billing?.multiplier}
        />
        <Row
          label="is_premium"
          value={billing?.is_premium}
        />
        <Row label="restricted_to">{restricted.length > 0 ? restricted.map((p) => <Chip key={p}>{p}</Chip>) : renderValue(undefined)}</Row>
      </Section>

      <Section title="Policy">
        <Row
          label="state"
          value={policy?.state}
        />
        <Row
          label="terms"
          value={policy?.terms}
        />
      </Section>
    </div>
  )
}
