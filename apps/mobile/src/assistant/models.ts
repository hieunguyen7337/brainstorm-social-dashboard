/**
 * The models the person can pick for the Assistant (Settings > Claude), and what each one's request needs.
 * Pure: no react-native import. The choice itself is stored by `modelStore.ts`.
 */

export type ModelId = 'claude-opus-5-5' | 'claude-sonnet-5-5' | 'claude-haiku-5-5';

export interface ModelOption {
  id: ModelId;
  /** Short name for the Assistant header. */
  name: string;
  /** Picker label. */
  label: string;
  /** The API accepts server-side refusal fallbacks (`fallbacks: "default"`) for this model. */
  fallbacks: boolean;
}

export const MODELS: readonly ModelOption[] = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', label: 'Claude Opus 5.5 (best, default)', fallbacks: true },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', label: 'Claude Sonnet 5.5 (faster, cheaper)', fallbacks: true },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', label: 'Claude Haiku 5.5 (fastest, cheapest)', fallbacks: false },
];

export const DEFAULT_MODEL: ModelId = 'claude-opus-5-5';

/** A stored or typed value -> a known model id; anything else (stale, tampered, missing) is the default. */
export function resolveModel(value: unknown): ModelId {
  return MODELS.find((m) => m.id === value)?.id ?? DEFAULT_MODEL;
}

export function modelOption(value: unknown): ModelOption {
  const id = resolveModel(value);
  return MODELS.find((m) => m.id === id) as ModelOption;
}

/**
 * The model-specific part of a Messages request. All three think adaptively with an explicit `effort`; tool choice stays
 * auto (forcing a tool is rejected on Opus and Sonnet 5.5). Fallbacks are sent only where the API supports them.
 */
export function modelRequestOptions(value: unknown) {
  const m = modelOption(value);
  return {
    model: m.id,
    thinking: { type: 'adaptive' as const },
    output_config: { effort: 'medium' as const },
    ...(m.fallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : null),
  };
}
