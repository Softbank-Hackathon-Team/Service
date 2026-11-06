// PERM-GATE: 멈춘 전이 detail 의 고객 권한 차이 읽기. 사전 점검(detail.permissions.permissionGaps)·apply 403 안전망(detail.envLayer.permissionGaps) 둘 다, 모양이 틀린 줄은 버린다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastPrecheckBounce, permissionGapsOf, stopHelpOf } from '../src/lib/timelineDetail';
import { fixableGaps } from '../src/features/environments/permissions-model';
import type { PermissionGap, TimelineItem } from '../src/lib/types';

const ENV = '00000000-0000-4000-8000-000000000001';
const gap = (o: Partial<PermissionGap> = {}): PermissionGap => ({ bundleId: 'gcp.env', envId: ENV, cloud: 'gcp', stage: 'env', side: 'target', principal: 'svc-env', role: 'platform_env',
  requiredWhen: ['env_layer_create'], level: 'block', missing: ['compute.addresses.setLabels'], missingApis: [], grantedVersion: null, requiredVersion: 1, ...o });

test('사전 점검 되돌림: 점검 항목과 같은 전이의 권한 차이를 같이 읽는다', () => {
  const items = [{ kind: 'transition', at: '2026-11-06T12:00:00Z', from: 'prechecking', to: 'spec_review', measurements: [],
    detail: { precheck: [{ id: 'PC-PERM-gcp.env', level: 'block', message: 'FAIL 고객 권한 gcp.env' }],
      permissions: { missing: ['gcp: svc-env compute.addresses.setLabels'], hint: '환경 화면의 [Cloud Shell 에서 갱신]', permissionGaps: [gap()] } } }] as unknown as TimelineItem[];
  const b = lastPrecheckBounce(items)!;
  assert.equal(b.items[0]!.id, 'PC-PERM-gcp.env');
  assert.deepEqual(b.gaps.map((g) => g.bundleId), ['gcp.env']);
  // 같은 detail 의 missing·hint 는 멈춤 도움말이 읽는다
  assert.deepEqual(stopHelpOf(b.items.length ? items[0]!.detail : {}).missing, ['gcp: svc-env compute.addresses.setLabels']);
});

test('apply 403 안전망: 단계 칸 안의 permissionGaps 도 읽고, 모양이 틀린 줄은 버린다', () => {
  assert.deepEqual(permissionGapsOf({ envLayer: { failureCode: 'ENV_LAYER_APPLY_FAILED', permissionGaps: [gap(), { bundleId: 1 }, { ...gap(), cloud: 'azure' }] } }).length, 1);
  assert.deepEqual(permissionGapsOf({ permissionGaps: 'nope' }), []);
  assert.deepEqual(permissionGapsOf({}), []);
});

test('고객 링크로 고쳐지는 묶음만 센다 (확인 못 함·권한표에 없는 것만 있는 묶음은 뺀다)', () => {
  const gs = [gap(), gap({ bundleId: 'gcp.observe.target', missing: [], unverified: 'x', level: 'warn' }), gap({ bundleId: 'gcp.operate', missing: [], notInTable: ['x.y.z'] }),
    gap({ bundleId: 'gcp.plan', missing: [], missingApis: ['container.googleapis.com'] })];
  assert.deepEqual(fixableGaps(gs).map((g) => g.bundleId), ['gcp.env', 'gcp.plan']);
});
