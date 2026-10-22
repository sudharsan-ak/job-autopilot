import { z } from "zod";

const BatchSelector = {
  batch_id: z.string().min(1).optional(),
  batch_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
};

export const FieldResolutionSchema = z.object({
  job_id: z.string().min(1).optional(),
  field_id: z.string().min(1),
  action: z.enum(["FILL", "SKIP", "ASK_USER"]),
  answer: z.union([z.string(), z.boolean()]).optional(),
  profile_field: z.string().min(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export const BatchApplicationInputSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("load"), batch_path: z.string().min(1) }),
  z.object({
    mode: z.literal("prepare"),
    ...BatchSelector,
    rows: z.array(z.number().int().positive()).min(1).optional(),
    count: z.number().int().min(1).max(50).optional(),
    wait_ms: z.number().int().min(0).max(120_000).default(30_000),
  }),
  z.object({
    mode: z.literal("resolve_fields"),
    wave_id: z.string().min(1),
    resolutions: z.array(FieldResolutionSchema).min(1),
  }),
  z.object({ mode: z.literal("status"), ...BatchSelector, wave_id: z.string().optional() }),
  z.object({ mode: z.literal("pause"), wave_id: z.string().optional(), ...BatchSelector }),
  z.object({ mode: z.literal("resume"), wave_id: z.string().optional(), ...BatchSelector, wait_ms: z.number().int().min(0).max(120_000).default(30_000) }),
  z.object({ mode: z.literal("stop"), wave_id: z.string().optional(), ...BatchSelector }),
  z.object({
    mode: z.literal("mark_applied"),
    ...BatchSelector,
    rows: z.array(z.number().int().positive()).min(1),
    note: z.string().max(1_000).optional(),
  }),
  z.object({
    mode: z.literal("results"),
    ...BatchSelector,
    finalize: z.boolean().default(false),
    filters: z.object({
      date_from: z.string().optional(),
      date_to: z.string().optional(),
      company: z.string().optional(),
      title: z.string().optional(),
      status: z.array(z.string()).optional(),
      ats: z.string().optional(),
    }).optional(),
    group_by: z.enum(["day", "company", "ats", "status"]).optional(),
  }),
]);

export type BatchApplicationInput = z.infer<typeof BatchApplicationInputSchema>;

export const TestToolInputSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("health") }),
  z.object({ mode: z.literal("validate_manifest"), batch_path: z.string().min(1) }),
  z.object({ mode: z.literal("dry_run_fixture") }),
  z.object({ mode: z.literal("database_check") }),
  z.object({ mode: z.literal("inspect_url"), url: z.string().url(), retain_tab: z.boolean().default(false) }),
  z.object({ mode: z.literal("dry_plan"), url: z.string().url(), retain_tab: z.boolean().default(false) }),
  z.object({
    mode: z.literal("simplify_autofill"),
    url: z.string().url(),
    reuse_existing_tab: z.boolean().default(true),
    retain_tab: z.boolean().default(true),
    wait_ms: z.number().int().min(10_000).max(180_000).default(120_000),
  }),
  z.object({
    mode: z.literal("inspect_form"),
    url: z.string().url(),
    reuse_existing_tab: z.boolean().default(true),
    retain_tab: z.boolean().default(false),
  }),
]);

export type TestToolInput = z.infer<typeof TestToolInputSchema>;
export const ToolOutputSchema = z.object({ ok: z.boolean() }).passthrough();
