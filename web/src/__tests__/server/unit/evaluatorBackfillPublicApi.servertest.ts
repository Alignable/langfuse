const mocks = vi.hoisted(() => ({
  applyCommentFilters: vi.fn(),
  getObservationsCountFromEventsTable: vi.fn(),
  queueAdd: vi.fn(),
  evaluatorFindFirst: vi.fn(),
  evaluatorCount: vi.fn(),
  batchActionCreate: vi.fn(),
  batchActionUpdate: vi.fn(),
  batchActionFindUnique: vi.fn(),
}));

vi.mock("@langfuse/shared/src/server", async (importOriginal) => {
  const actual = await importOriginal<typeof SharedServerModule>();
  return {
    ...actual,
    applyCommentFilters: mocks.applyCommentFilters,
    getObservationsCountFromEventsTable:
      mocks.getObservationsCountFromEventsTable,
    BatchActionQueue: {
      getInstance: vi.fn(() => ({ add: mocks.queueAdd })),
    },
  };
});

vi.mock("@langfuse/shared/src/db", async (importOriginal) => {
  const actual = await importOriginal<typeof SharedDbModule>();
  return {
    ...actual,
    prisma: {
      evaluator: {
        findFirst: mocks.evaluatorFindFirst,
        count: mocks.evaluatorCount,
      },
      batchAction: {
        create: mocks.batchActionCreate,
        update: mocks.batchActionUpdate,
        findUnique: mocks.batchActionFindUnique,
      },
    },
  };
});

vi.mock("@/src/features/audit-logs/auditLog", () => ({
  auditLog: vi.fn(),
}));

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as SharedServerModule from "@langfuse/shared/src/server";
import type * as SharedDbModule from "@langfuse/shared/src/db";
import type { ApiAccessScope } from "@langfuse/shared/src/server";
import {
  ActionId,
  BatchActionStatus,
  InvalidRequestError,
  LangfuseNotFoundError,
} from "@langfuse/shared";
import { env } from "@/src/env.mjs";
import {
  createEvaluatorBackfillForPublicApi,
  getEvaluatorBackfillForPublicApi,
} from "@/src/features/public-api/server/evaluation/evaluatorBackfillApiService";
import { CreateEvaluatorBackfillBody } from "@/src/features/public-api/types/evaluation/evaluatorBackfills";

// Alignable fork delta: POST/GET /api/public/v2/evaluators/{id}/backfills.
const mutableEnv = env as unknown as {
  LANGFUSE_MIGRATION_V4_ALLOW_PREVIEW_OPT_IN: "true" | "false";
  LANGFUSE_MAX_HISTORIC_EVAL_CREATION_LIMIT: number;
};
const originalEnv = { ...mutableEnv };

const projectId = "project-id";
const evaluatorId = "evaluator-id";
const auditScope = {
  projectId,
  orgId: "org-id",
  apiKeyId: "api-key-id",
  accessLevel: "project",
} as ApiAccessScope;
const traceNameFilter = {
  type: "string" as const,
  column: "traceName",
  operator: "=" as const,
  value: "retention_coach",
};

function parseBody(raw: unknown) {
  return CreateEvaluatorBackfillBody.parse(raw);
}

function createBackfill(raw: Record<string, unknown> = {}) {
  return createEvaluatorBackfillForPublicApi({
    projectId,
    evaluatorId,
    input: parseBody({
      fromStartTime: "2026-09-01T00:00:00Z",
      toStartTime: "2026-09-02T00:00:00Z",
      filter: [traceNameFilter],
      ...raw,
    }),
    auditScope,
  });
}

describe("evaluator backfill public API (Alignable fork delta)", () => {
  beforeEach(() => {
    mutableEnv.LANGFUSE_MIGRATION_V4_ALLOW_PREVIEW_OPT_IN = "true";
    mutableEnv.LANGFUSE_MAX_HISTORIC_EVAL_CREATION_LIMIT = 50_000;
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.evaluatorFindFirst.mockResolvedValue({
      id: evaluatorId,
      blockedAt: null,
      blockMessage: null,
    });
    mocks.evaluatorCount.mockResolvedValue(1);
    mocks.applyCommentFilters.mockImplementation(async ({ filterState }) => ({
      filterState,
      hasNoMatches: false,
    }));
    mocks.getObservationsCountFromEventsTable.mockResolvedValue(1234);
    mocks.batchActionCreate.mockImplementation(async ({ data }) => ({
      ...data,
      id: "batch-action-id",
      createdAt: new Date("2026-09-30T12:00:00Z"),
      finishedAt: null,
      totalCount: null,
      processedCount: null,
      failedCount: null,
      log: null,
    }));
    mocks.queueAdd.mockResolvedValue(undefined);
  });

  afterAll(() => {
    Object.assign(mutableEnv, originalEnv);
  });

  describe("body contract", () => {
    it("requires the time window", () => {
      expect(
        CreateEvaluatorBackfillBody.safeParse({ filter: [] }).success,
      ).toBe(false);
    });

    it("rejects a window where fromStartTime is not before toStartTime", () => {
      expect(
        CreateEvaluatorBackfillBody.safeParse({
          fromStartTime: "2026-09-02T00:00:00Z",
          toStartTime: "2026-09-01T00:00:00Z",
        }).success,
      ).toBe(false);
    });

    it("accepts the filter as a JSON string", () => {
      const body = parseBody({
        fromStartTime: "2026-09-01T00:00:00Z",
        toStartTime: "2026-09-02T00:00:00Z",
        filter: JSON.stringify([traceNameFilter]),
      });
      expect(body.filter).toEqual([traceNameFilter]);
    });

    it("rejects unknown keys", () => {
      expect(
        CreateEvaluatorBackfillBody.safeParse({
          fromStartTime: "2026-09-01T00:00:00Z",
          toStartTime: "2026-09-02T00:00:00Z",
          evaluatorIds: ["other"],
        }).success,
      ).toBe(false);
    });
  });

  it("queues the same v2 batch evaluation the UI queues, with the time window in the filter", async () => {
    const result = await createBackfill({ sampling: 0.5 });

    const expectedFilter = [
      traceNameFilter,
      {
        column: "startTime",
        operator: ">=",
        value: new Date("2026-09-01T00:00:00Z"),
        type: "datetime",
      },
      {
        column: "startTime",
        operator: "<",
        value: new Date("2026-09-02T00:00:00Z"),
        type: "datetime",
      },
    ];

    expect(mocks.getObservationsCountFromEventsTable).toHaveBeenCalledWith({
      projectId,
      filter: expectedFilter,
    });

    const created = mocks.batchActionCreate.mock.calls[0][0].data;
    expect(created).toMatchObject({
      projectId,
      userId: "api-key:api-key-id",
      actionType: ActionId.ObservationBatchEvaluation,
      status: BatchActionStatus.Queued,
      query: { filter: expectedFilter, orderBy: null },
      config: {
        evaluatorIds: [evaluatorId],
        evalVersion: "v2",
        sampling: 0.5,
        matchedObservationCount: 1234,
      },
    });

    const [, job, opts] = mocks.queueAdd.mock.calls[0];
    expect(opts).toEqual({ jobId: "batch-action-id" });
    expect(job.payload).toMatchObject({
      actionId: ActionId.ObservationBatchEvaluation,
      batchActionId: "batch-action-id",
      projectId,
      evaluatorIds: [evaluatorId],
      evalVersion: "v2",
      sampling: 0.5,
      query: { filter: expectedFilter, orderBy: null },
    });
    expect(job.payload).not.toHaveProperty("rowLimit");
    expect(job.payload).not.toHaveProperty("evaluatorMappings");

    expect(result).toMatchObject({
      id: "batch-action-id",
      evaluatorId,
      status: BatchActionStatus.Queued,
      fromStartTime: "2026-09-01T00:00:00.000Z",
      toStartTime: "2026-09-02T00:00:00.000Z",
      sampling: 0.5,
      rowLimit: null,
      matchedObservationCount: 1234,
    });
  });

  it("returns 404 for an evaluator in another project or not found", async () => {
    mocks.evaluatorFindFirst.mockResolvedValue(null);
    await expect(createBackfill()).rejects.toBeInstanceOf(
      LangfuseNotFoundError,
    );
    expect(mocks.batchActionCreate).not.toHaveBeenCalled();
  });

  it("rejects a blocked evaluator", async () => {
    mocks.evaluatorFindFirst.mockResolvedValue({
      id: evaluatorId,
      blockedAt: new Date(),
      blockMessage: "LLM connection missing",
    });
    await expect(createBackfill()).rejects.toThrow(/LLM connection missing/);
    expect(mocks.batchActionCreate).not.toHaveBeenCalled();
  });

  it("rejects an evaluator assigned to a trace or dataset rule", async () => {
    mocks.evaluatorCount.mockResolvedValue(0);
    await expect(createBackfill()).rejects.toBeInstanceOf(InvalidRequestError);
    expect(mocks.batchActionCreate).not.toHaveBeenCalled();
  });

  it("rejects a window with more matches than the instance limit", async () => {
    mutableEnv.LANGFUSE_MAX_HISTORIC_EVAL_CREATION_LIMIT = 1000;
    await expect(createBackfill()).rejects.toThrow(
      /1234 observations match, but one backfill can evaluate at most 1000/,
    );
    expect(mocks.batchActionCreate).not.toHaveBeenCalled();
  });

  it("allows too many matches when rowLimit opts in", async () => {
    mutableEnv.LANGFUSE_MAX_HISTORIC_EVAL_CREATION_LIMIT = 1000;
    await createBackfill({ rowLimit: 500 });
    expect(mocks.queueAdd.mock.calls[0][1].payload.rowLimit).toBe(500);
  });

  it("rejects rowLimit above the instance limit", async () => {
    mutableEnv.LANGFUSE_MAX_HISTORIC_EVAL_CREATION_LIMIT = 1000;
    await expect(createBackfill({ rowLimit: 5000 })).rejects.toBeInstanceOf(
      InvalidRequestError,
    );
  });

  it("does not count when a comment filter matches nothing", async () => {
    mocks.applyCommentFilters.mockResolvedValue({
      filterState: [],
      hasNoMatches: true,
    });
    const result = await createBackfill();
    expect(mocks.getObservationsCountFromEventsTable).not.toHaveBeenCalled();
    expect(result.matchedObservationCount).toBe(0);
  });

  it("marks the row FAILED when the job cannot be queued", async () => {
    mocks.queueAdd.mockRejectedValue(new Error("redis down"));
    await expect(createBackfill()).rejects.toThrow("redis down");
    expect(mocks.batchActionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "batch-action-id", projectId },
        data: expect.objectContaining({ status: BatchActionStatus.Failed }),
      }),
    );
  });

  it("returns 404 when the v4 events table is not enabled", async () => {
    mutableEnv.LANGFUSE_MIGRATION_V4_ALLOW_PREVIEW_OPT_IN = "false";
    await expect(createBackfill()).rejects.toBeInstanceOf(
      LangfuseNotFoundError,
    );
  });

  describe("get", () => {
    const row = {
      id: "batch-action-id",
      projectId,
      actionType: ActionId.ObservationBatchEvaluation,
      status: BatchActionStatus.Completed,
      query: { filter: [traceNameFilter], orderBy: null },
      config: {
        evaluatorIds: [evaluatorId],
        evalVersion: "v2",
        fromStartTime: "2026-09-01T00:00:00.000Z",
        toStartTime: "2026-09-02T00:00:00.000Z",
        matchedObservationCount: 10,
      },
      totalCount: 10,
      processedCount: 9,
      failedCount: 1,
      log: "1 observations failed",
      createdAt: new Date("2026-09-30T12:00:00Z"),
      finishedAt: new Date("2026-09-30T12:05:00Z"),
    };

    it("returns progress for the evaluator's backfill", async () => {
      mocks.batchActionFindUnique.mockResolvedValue(row);
      const result = await getEvaluatorBackfillForPublicApi({
        projectId,
        evaluatorId,
        backfillId: "batch-action-id",
      });
      expect(mocks.batchActionFindUnique).toHaveBeenCalledWith({
        where: { id: "batch-action-id", projectId },
      });
      expect(result).toMatchObject({
        status: BatchActionStatus.Completed,
        totalCount: 10,
        processedCount: 9,
        failedCount: 1,
        sampling: 1,
        finishedAt: "2026-09-30T12:05:00.000Z",
      });
    });

    it("returns 404 for a batch action of a different evaluator", async () => {
      mocks.batchActionFindUnique.mockResolvedValue(row);
      await expect(
        getEvaluatorBackfillForPublicApi({
          projectId,
          evaluatorId: "other-evaluator",
          backfillId: "batch-action-id",
        }),
      ).rejects.toBeInstanceOf(LangfuseNotFoundError);
    });

    it("returns 404 for a batch action that is not an evaluation", async () => {
      mocks.batchActionFindUnique.mockResolvedValue({
        ...row,
        actionType: ActionId.ObservationAddToDataset,
      });
      await expect(
        getEvaluatorBackfillForPublicApi({
          projectId,
          evaluatorId,
          backfillId: "batch-action-id",
        }),
      ).rejects.toBeInstanceOf(LangfuseNotFoundError);
    });
  });
});
