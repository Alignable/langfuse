import {
  ActionId,
  BatchActionQuerySchema,
  BatchActionStatus,
  BatchTableNames,
  InternalServerError,
  InvalidRequestError,
  LangfuseNotFoundError,
  type BatchActionQuery,
  type FilterCondition,
} from "@langfuse/shared";
import { prisma, type BatchAction } from "@langfuse/shared/src/db";
import {
  applyCommentFilters,
  BatchActionQueue,
  getObservationsCountFromEventsTable,
  logger,
  QueueJobs,
  type ApiAccessScope,
} from "@langfuse/shared/src/server";
import { z } from "zod";
import { auditLog } from "@/src/features/audit-logs/server";
import { env } from "@/src/env.mjs";
import { batchEligibleEvaluatorWhere } from "@/src/features/evals/v2/server/evaluators/evaluatorRepository";
import type {
  CreateEvaluatorBackfillBodyType,
  EvaluatorBackfillType,
} from "@/src/features/public-api/types/evaluation/evaluatorBackfills";

const BACKFILL_SOURCE = "public-api-backfill";

// Extra keys the backfill stores next to the fields the batch-eval worker reads.
const BackfillConfig = z.object({
  evaluatorIds: z.array(z.string()),
  sampling: z.number().optional(),
  rowLimit: z.number().optional(),
  fromStartTime: z.string().optional(),
  toStartTime: z.string().optional(),
  matchedObservationCount: z.number().optional(),
});

function assertEventsTableEnabled() {
  if (env.LANGFUSE_MIGRATION_V4_ALLOW_PREVIEW_OPT_IN !== "true") {
    throw new LangfuseNotFoundError(
      "Evaluator backfills are only available in a Langfuse v4 write mode.",
    );
  }
}

function toPublicBackfill(
  batchAction: BatchAction,
  evaluatorId: string,
): EvaluatorBackfillType {
  const config = BackfillConfig.safeParse(batchAction.config);
  const query = BatchActionQuerySchema.safeParse(batchAction.query);

  return {
    id: batchAction.id,
    evaluatorId,
    status: batchAction.status as BatchActionStatus,
    fromStartTime: config.data?.fromStartTime ?? null,
    toStartTime: config.data?.toStartTime ?? null,
    filter: query.data?.filter ?? [],
    sampling: config.data?.sampling ?? 1,
    rowLimit: config.data?.rowLimit ?? null,
    matchedObservationCount: config.data?.matchedObservationCount ?? null,
    totalCount: batchAction.totalCount,
    processedCount: batchAction.processedCount,
    failedCount: batchAction.failedCount,
    log: batchAction.log,
    createdAt: batchAction.createdAt.toISOString(),
    finishedAt: batchAction.finishedAt?.toISOString() ?? null,
  };
}

export async function createEvaluatorBackfillForPublicApi(params: {
  projectId: string;
  evaluatorId: string;
  input: CreateEvaluatorBackfillBodyType;
  auditScope: ApiAccessScope;
}): Promise<EvaluatorBackfillType> {
  const { projectId, evaluatorId, input, auditScope } = params;
  assertEventsTableEnabled();

  const evaluator = await prisma.evaluator.findFirst({
    where: { id: evaluatorId, projectId },
    select: { id: true, blockedAt: true, blockMessage: true },
  });
  if (!evaluator) {
    throw new LangfuseNotFoundError("Evaluator not found");
  }
  if (evaluator.blockedAt) {
    throw new InvalidRequestError(
      `Evaluator is blocked${evaluator.blockMessage ? `: ${evaluator.blockMessage}` : "."}`,
    );
  }
  const isBatchEligible = await prisma.evaluator.count({
    where: { id: evaluatorId, projectId, ...batchEligibleEvaluatorWhere },
  });
  if (isBatchEligible === 0) {
    throw new InvalidRequestError(
      "Evaluator is assigned to a trace or dataset evaluation rule and cannot run as an observation backfill.",
    );
  }

  const maxRows = env.LANGFUSE_MAX_HISTORIC_EVAL_CREATION_LIMIT;
  if (input.rowLimit !== undefined && input.rowLimit > maxRows) {
    throw new InvalidRequestError(
      `rowLimit must not exceed ${maxRows} (LANGFUSE_MAX_HISTORIC_EVAL_CREATION_LIMIT).`,
    );
  }

  const filter: FilterCondition[] = [
    ...(input.filter ?? []),
    {
      column: "startTime",
      operator: ">=",
      value: input.fromStartTime,
      type: "datetime",
    },
    {
      column: "startTime",
      operator: "<",
      value: input.toStartTime,
      type: "datetime",
    },
  ];
  const query: BatchActionQuery = { filter, orderBy: null };

  // Comment filters resolve in Postgres; the worker resolves them again from
  // the stored query, so only the count uses the resolved form.
  const commentFilterResult = await applyCommentFilters({
    filterState: filter,
    prisma,
    projectId,
    objectType: "OBSERVATION",
  });
  const matchedObservationCount = commentFilterResult.hasNoMatches
    ? 0
    : await getObservationsCountFromEventsTable({
        projectId,
        filter: commentFilterResult.filterState,
      });

  if (input.rowLimit === undefined && matchedObservationCount > maxRows) {
    throw new InvalidRequestError(
      `${matchedObservationCount} observations match, but one backfill can evaluate at most ${maxRows}. Use a smaller time window, or set rowLimit to evaluate only the newest observations.`,
    );
  }

  const queue = BatchActionQueue.getInstance();
  if (!queue) {
    throw new InternalServerError("Batch action queue is not available.");
  }

  const config = {
    evaluatorIds: [evaluatorId],
    evalVersion: "v2" as const,
    ...(input.sampling !== undefined ? { sampling: input.sampling } : {}),
    ...(input.rowLimit !== undefined ? { rowLimit: input.rowLimit } : {}),
    source: BACKFILL_SOURCE,
    fromStartTime: input.fromStartTime.toISOString(),
    toStartTime: input.toStartTime.toISOString(),
    matchedObservationCount,
  };

  const batchAction = await prisma.batchAction.create({
    data: {
      projectId,
      // BatchAction.userId has no user FK; the UI shows no user for this id.
      userId: `api-key:${auditScope.apiKeyId}`,
      actionType: ActionId.ObservationBatchEvaluation,
      tableName: BatchTableNames.Events,
      status: BatchActionStatus.Queued,
      query,
      config,
    },
  });

  await auditLog({
    resourceType: "batchAction",
    resourceId: batchAction.id,
    action: ActionId.ObservationBatchEvaluation,
    projectId,
    orgId: auditScope.orgId,
    apiKeyId: auditScope.apiKeyId,
    after: batchAction,
  });

  try {
    await queue.add(
      QueueJobs.BatchActionProcessingJob,
      {
        id: batchAction.id,
        name: QueueJobs.BatchActionProcessingJob,
        timestamp: new Date(),
        payload: {
          actionId: ActionId.ObservationBatchEvaluation,
          batchActionId: batchAction.id,
          projectId,
          cutoffCreatedAt: new Date(),
          query,
          evaluatorIds: config.evaluatorIds,
          evalVersion: config.evalVersion,
          ...(input.sampling !== undefined ? { sampling: input.sampling } : {}),
          ...(input.rowLimit !== undefined ? { rowLimit: input.rowLimit } : {}),
        },
      },
      { jobId: batchAction.id },
    );
  } catch (error) {
    // Without this the row stays QUEUED although no job exists.
    await prisma.batchAction.update({
      where: { id: batchAction.id, projectId },
      data: {
        status: BatchActionStatus.Failed,
        finishedAt: new Date(),
        log: "Failed to enqueue the backfill job.",
      },
    });
    throw error;
  }

  logger.info("[Public API] Created evaluator backfill", {
    projectId,
    evaluatorId,
    batchActionId: batchAction.id,
    matchedObservationCount,
  });

  return toPublicBackfill(batchAction, evaluatorId);
}

export async function getEvaluatorBackfillForPublicApi(params: {
  projectId: string;
  evaluatorId: string;
  backfillId: string;
}): Promise<EvaluatorBackfillType> {
  const { projectId, evaluatorId, backfillId } = params;
  assertEventsTableEnabled();

  const batchAction = await prisma.batchAction.findUnique({
    where: { id: backfillId, projectId },
  });
  const config = BackfillConfig.safeParse(batchAction?.config);

  // Also returns batch evaluations started from the UI for this evaluator.
  if (
    !batchAction ||
    batchAction.actionType !== ActionId.ObservationBatchEvaluation ||
    !config.data?.evaluatorIds.includes(evaluatorId)
  ) {
    throw new LangfuseNotFoundError("Evaluator backfill not found");
  }

  return toPublicBackfill(batchAction, evaluatorId);
}
