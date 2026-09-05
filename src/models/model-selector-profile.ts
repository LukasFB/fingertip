import { createHash } from "node:crypto";

import { MODEL_EFFORTS, MODEL_FAMILIES } from "./model-selection.ts";

interface ProfileAction {
  readonly UUID: string;
  readonly Settings: { readonly family?: string; readonly effort?: string };
}

const actions: Record<string, ProfileAction> = {};
for (const [row, family] of MODEL_FAMILIES.entries()) {
  for (const [column, effort] of MODEL_EFFORTS.entries()) {
    actions[`${column},${row}`] = {
      UUID: "com.lukas-bhm.fingertip.model-option",
      Settings: { family, effort },
    };
  }
}
actions["5,0"] = { UUID: "com.lukas-bhm.fingertip.fast-mode", Settings: {} };
actions["7,3"] = { UUID: "com.lukas-bhm.fingertip.model-selector-back", Settings: {} };
export const MODEL_SELECTOR_ACTIONS: Readonly<Record<string, ProfileAction>> = Object.freeze(actions);

/** A changed layout must never resolve to a previously installed profile copy. */
export function modelSelectorProfileIdentity(layout: Readonly<Record<string, ProfileAction>>) {
  const digest = createHash("sha256").update(JSON.stringify({
    format: 1,
    device: "20GAT9902",
    actions: Object.entries(layout).sort(([left], [right]) => left.localeCompare(right)),
  })).digest("hex");
  const uuid = (seed: string) => {
    const bytes = createHash("sha256").update(seed).digest();
    bytes[6] = (bytes[6]! & 0x0f) | 0x50;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = bytes.toString("hex").slice(0, 32);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`.toUpperCase();
  };
  return Object.freeze({
    name: `profiles/codex-model-selector-${digest.slice(0, 16)}`,
    profileId: uuid(`profile:${digest}`),
    pageId: uuid(`page:${digest}`),
  });
}

export const MODEL_SELECTOR_PROFILE = modelSelectorProfileIdentity(MODEL_SELECTOR_ACTIONS);
