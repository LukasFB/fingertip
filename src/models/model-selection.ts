export const MODEL_FAMILIES = ["astra", "sol", "terra", "luna"] as const;
export const MODEL_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export type ModelFamily = typeof MODEL_FAMILIES[number];
export type ModelEffort = typeof MODEL_EFFORTS[number];

const MODEL_IDS = {
  astra: "gpt-6-astra",
  sol: "gpt-5.6-sol",
  terra: "gpt-5.6-terra",
  luna: "gpt-5.6-luna",
} as const;

export interface ModelSelection {
  readonly family: ModelFamily;
  readonly model: typeof MODEL_IDS[ModelFamily];
  readonly effort: ModelEffort;
  readonly modelLabel: "ASTRA 6" | "SOL" | "TERRA" | "LUNA";
  readonly effortLabel: "LIGHT" | "MEDIUM" | "HIGH" | "EXTRA HIGH" | "MAX";
}

const effortLabels: Readonly<Record<ModelEffort, ModelSelection["effortLabel"]>> = Object.freeze({
  low: "LIGHT",
  medium: "MEDIUM",
  high: "HIGH",
  xhigh: "EXTRA HIGH",
  max: "MAX",
});

export function modelSelection(family: ModelFamily, effort: ModelEffort): ModelSelection {
  return Object.freeze({
    family,
    model: MODEL_IDS[family],
    effort,
    modelLabel: family === "astra" ? "ASTRA 6" : family.toUpperCase() as ModelSelection["modelLabel"],
    effortLabel: effortLabels[effort],
  });
}

export function normalizeModelSelection(value: unknown): ModelSelection | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const family = MODEL_FAMILIES.find((candidate) => candidate === record.family);
  const effort = MODEL_EFFORTS.find((candidate) => candidate === record.effort);
  return family === undefined || effort === undefined ? null : modelSelection(family, effort);
}

export function modelSelectionMatches(
  selection: ModelSelection,
  settings: {
    readonly model?: string | null | undefined;
    readonly effort?: string | null | undefined;
  },
): boolean {
  return settings.model === selection.model && settings.effort === selection.effort;
}

export function modelSelectionImagePath(selection: ModelSelection, selected = false): string {
  return `imgs/actions/model-options/${selection.family}-${selection.effort}${selected ? "-selected" : ""}.png`;
}
