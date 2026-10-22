import { z } from "zod";

export const ProfileFieldSchema = z.object({
  value: z.unknown(),
  status: z.string().optional(),
  approval: z.string().optional(),
  policy_category: z.string().optional(),
  sensitivity: z.string().optional(),
  store_value: z.boolean().optional(),
  value_type: z.string().optional(),
  source: z.unknown().optional(),
  approved_question_scope: z.unknown().optional(),
  last_confirmed_at: z.unknown().optional(),
  notes: z.unknown().optional(),
}).passthrough();

export const ApplicantProfileSchema = z.object({
  schema_version: z.unknown().optional(),
  fields: z.record(z.string(), z.record(z.string(), ProfileFieldSchema)),
  employment_history: z.array(z.record(z.string(), z.unknown())).default([]),
  education_history: z.array(z.record(z.string(), z.unknown())).default([]),
}).passthrough();

export type ApplicantProfile = z.infer<typeof ApplicantProfileSchema>;
export type ProfileField = z.infer<typeof ProfileFieldSchema>;

export interface RuntimeProfileField extends ProfileField {
  key: string;
  category: string;
}
