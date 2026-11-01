// @svc/replication — Postgres 논리 복제(CDC) 기반 DB 이전 모듈.
// 워커는 Migration 클래스만 쓰면 된다: precheck → sync(반복) → cutover → (rollback) → teardown
export { type Endpoint, type Provider, type SslMode, type EndpointTls, endpointFromEnv, connect, withClient, clientConfig, peerTlsProblem, workerTlsProblem, peerPathProblem, isPrivateHost, isManaged } from "./endpoint.js";
export { namesFor, type Names } from "./names.js";
export { precheck, ensureReplicationAttr, type Check, type PrecheckResult } from "./precheck.js";
export { copyStatus, waitInitialCopy, sampleLag, markerLagMs, slotLag, type CopyStatus, type LagSample, type SlotLag } from "./lag.js";
export { judgeCutoverReady, DEFAULT_GATE, type GateOpts, type GateResult } from "./judge.js";
export { fence, unfence, appCanWrite, writableTables } from "./fence.js";
export { switchover, SwitchoverError, NO_TRAFFIC_HOOKS, type TrafficHooks, type SwitchoverInput, type SwitchoverResult, type SwitchoverFailure, type StepMeasure } from "./switchover.js";
export { Migration, type MigrationConfig, type Phase, type SyncReport, type FenceRecovery } from "./migration.js";
export { type TableRef, rowCounts, checksum, listTables } from "./tables.js";
export { replicationFromEnv, toMeasurements } from "./worker.js";
export { ensureReplUser, dropReplUser, replUserOf, subscriptionConninfo, ephemeralEnabled } from "./repluser.js";
export { readTfFacts, resolveTfRefs, hasTfRef } from "./tf-facts.js";
export { copySchema, SchemaCopyError, isTransient, type SchemaCopyResult } from "./schema.js";
