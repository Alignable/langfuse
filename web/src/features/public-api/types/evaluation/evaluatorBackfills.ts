import {
  BatchActionStatus,
  InvalidRequestError,
  singleFilter,
} from "@langfuse/shared";
import { z } from "zod";

// Alignable fork delta: historical evaluator backfill through the public API.
// A backfill is an `observation-run-batched-evaluation` batch action, the same
// job the UI "Run evaluation" dialog queues.

const UtcDateTime = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value));

// Same filter conditions as the observations table in the UI. Accepts a JSON
// array, or the JSON string form used by the `filter` query parameter of
// GET /api/public/v2/observations.
const BackfillFilter = z.union([
  z.array(singleFilter),
  z
    .string()
    .transform((value) => {
      try {
        return JSON.parse(value) as unknown;
      } catch {
        throw new InvalidRequestError("Invalid JSON in filter parameter");
      }
    })
    .pipe(z.array(singleFilter)),
]);

export const CreateEvaluatorBackfillBody = z
  .object({
    // Observation start time window: fromStartTime <= startTime < toStartTime.
    fromStartTime: UtcDateTime,
    toStartTime: UtcDateTime,
    filter: BackfillFilter.optional(),
    sampling: z.number().min(0).max(1).optional(),
    // Opt in to evaluate only the newest `rowLimit` matches when more
    // observations match than the instance limit allows.
    rowLimit: z.number().int().positive().optional(),
  })
  .strict()
  .refine((body) => body.fromStartTime < body.toStartTime, {
    message: "fromStartTime must be before toStartTime.",
    path: ["toStartTime"],
  });

export type CreateEvaluatorBackfillBodyType = z.infer<
  typeof CreateEvaluatorBackfillBody
>;

export const EvaluatorBackfillIdQuery = z
  .object({ evaluatorId: z.string(), backfillId: z.string() })
  .strict();

export const EvaluatorBackfill = z
  .object({
    id: z.string(),
    evaluatorId: z.string(),
    // Status of the scheduling job. COMPLETED means an eval job was queued
    // for each matched observation; the judge calls run after that.
    status: z.enum(BatchActionStatus),
    fromStartTime: z.string().nullable(),
    toStartTime: z.string().nullable(),
    // The full filter the worker runs, including the time window.
    filter: z.array(singleFilter),
    sampling: z.number(),
    rowLimit: z.number().int().nullable(),
    matchedObservationCount: z.number().int().nullable(),
    totalCount: z.number().int().nullable(),
    processedCount: z.number().int().nullable(),
    failedCount: z.number().int().nullable(),
    log: z.string().nullable(),
    createdAt: z.string(),
    finishedAt: z.string().nullable(),
  })
  .strict();

export type EvaluatorBackfillType = z.infer<typeof EvaluatorBackfill>;
