export const SAFE_CHECKPOINTS = [
  "READY_FOR_REVIEW",
  "PARTIAL_READY_FOR_REVIEW",
  "NEEDS_AI_REVIEW",
  "BLOCKED",
] as const;

export type SafeCheckpoint = (typeof SAFE_CHECKPOINTS)[number];

export function isSafeCheckpoint(value: string): value is SafeCheckpoint {
  return (SAFE_CHECKPOINTS as readonly string[]).includes(value);
}
