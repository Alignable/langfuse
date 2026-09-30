import {
  createStablePublicApiRoute,
  withStablePublicApiMiddlewares,
} from "@/src/features/public-api/server/stablePublicApiRoute";
import {
  createEvaluatorBackfillForPublicApi,
  getEvaluatorBackfillForPublicApi,
} from "./evaluatorBackfillApiService";
import { EvaluatorIdQuery } from "@/src/features/public-api/types/evaluation/evaluators";
import {
  CreateEvaluatorBackfillBody,
  EvaluatorBackfill,
  EvaluatorBackfillIdQuery,
} from "@/src/features/public-api/types/evaluation/evaluatorBackfills";

export const evaluatorBackfillsApiHandler = withStablePublicApiMiddlewares({
  POST: createStablePublicApiRoute({
    name: "Create evaluator backfill",
    action: "evaluationRule:CUD",
    querySchema: EvaluatorIdQuery,
    bodySchema: CreateEvaluatorBackfillBody,
    responseSchema: EvaluatorBackfill,
    successStatusCode: 201,
    fn: ({ query, body, auth }) =>
      createEvaluatorBackfillForPublicApi({
        projectId: auth.scope.projectId,
        evaluatorId: query.evaluatorId,
        input: body,
        auditScope: auth.scope,
      }),
  }),
});

export const evaluatorBackfillApiHandler = withStablePublicApiMiddlewares({
  GET: createStablePublicApiRoute({
    name: "Get evaluator backfill",
    action: "evaluationRule:read",
    querySchema: EvaluatorBackfillIdQuery,
    responseSchema: EvaluatorBackfill,
    fn: ({ query, auth }) =>
      getEvaluatorBackfillForPublicApi({
        projectId: auth.scope.projectId,
        evaluatorId: query.evaluatorId,
        backfillId: query.backfillId,
      }),
  }),
});
