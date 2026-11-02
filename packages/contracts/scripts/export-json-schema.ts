// Zod 스키마를 JSON Schema 파일로 뽑는다. TypeScript를 안 쓰는 쪽(화면, 문서)도 같은 모양을 본다
import { mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import * as C from "../src/index.js";

const out = new URL("../schemas/", import.meta.url);
mkdirSync(out, { recursive: true });
const pick = {
  AppSpec: C.AppSpec, FieldMeta: C.FieldMeta, ImportResult: C.ImportResult,
  MigrationView: C.MigrationView, PlanDoc: C.PlanDoc, ApprovalInput: C.ApprovalInput,
  PrecheckItem: C.PrecheckItem, MigrationJob: C.MigrationJob, ApplyJob: C.ApplyJob,
  SseEvent: C.SseEvent, InfraReady: C.InfraReady, DeployResult: C.DeployResult,
  TrafficJudgement: C.TrafficJudgement, Finding: C.Finding, MatrixCell: C.MatrixCell,
  GuardrailEvent: C.GuardrailEvent, AgentFinish: C.AgentFinish,
  Measurement: C.Measurement, ApiError: C.ApiError,
  EnvironmentView: C.EnvironmentView, ConnectionLink: C.ConnectionLink,
  TransitionEvidence: C.TransitionEvidence, CostEstimateRequest: C.CostEstimateRequest,
  CostEstimate: C.CostEstimate, PriceCatalog: C.PriceCatalog,
  AppSpecV2: C.AppSpecV2, ImportResultV2: C.ImportResultV2,
  SpecPatchInput: C.SpecPatchInput,
  ModuleInstance: C.ModuleInstance,
  PostgresTfVars: C.PostgresTfVars, NamespaceTfVars: C.NamespaceTfVars, IdentityTfVars: C.IdentityTfVars,
  CacheTfVars: C.CacheTfVars, ObjectStoreTfVars: C.ObjectStoreTfVars, QueueTfVars: C.QueueTfVars, JobTfVars: C.JobTfVars,
};
for (const [name, schema] of Object.entries(pick)) {
  writeFileSync(new URL(`${name}.json`, out),
    JSON.stringify(z.toJSONSchema(schema as z.ZodType), null, 2));
}
console.log(`wrote ${Object.keys(pick).length} schemas`);
