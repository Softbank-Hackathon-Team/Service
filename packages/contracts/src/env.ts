// Z81 (PROPOSALS P1): 숫자 환경 변수 읽기 한 곳.
// 예전: Number(process.env.X ?? 기본값). `??` 는 값이 없을 때(undefined)만 기본값을 쓴다.
//   .env 에 `X=` 처럼 빈 줄이 있으면(node --env-file 은 빈 문자열로 넣는다) Number("") = 0 이 되어
//   MAX_CUTOVER_ATTEMPTS= → 시도 0번, ROLLBACK_WINDOW_SEC= → 창 0초 처럼 조용히 바뀌었다.
// 지금: 빈 문자열(공백만 있는 것 포함) = 설정 안 함 → 기본값. 그 밖은 예전과 똑같이 Number(v)
//   (숫자가 아닌 글자 → NaN, "0" → 0 그대로. 0 을 일부러 주는 변수(METRICS_PORT=0 = 끔)가 있어 `||` 로 바꾸지 않았다)
// 값을 직접 받는다: process.env.X 도, 주입한 env 객체의 env.X 도 같은 함수로 읽는다
export function envNumber(v: string | undefined, def: number): number {
  return v === undefined || v.trim() === "" ? def : Number(v);
}

// PF RV-09: terraform 시간 예산과 큐 기한을 한 곳에서. 예전엔 단계(init·plan·apply·destroy)마다 TF_APPLY_TIMEOUT_SEC(2700초)라
//   합이 pg-boss 기한(3600초)을 넘을 수 있었다 → 도는 중에 작업이 만료돼 다시 배달 → 같은 state 로 겹쳐 돎.
// 이제 실행기는 작업 전체 예산(JOB) 안에서만 단계를 돌리고, 실패 뒤 지우기는 따로 예산(DESTROY)을 갖는다.
// 큐 기한 = 예산 합 + 예산마다 정지 유예(GRACE, 시간 초과 뒤 SIGINT → SIGKILL 까지) + 여유 5분 → 기한이 먼저 오지 않는다
// DRAFT(ai): 기본 단계 2700·작업 2700·지우기 1800·유예 1200초. 실측 apply·destroy 시간으로 확정
export interface TfBudget { stepSec: number; jobSec: number; destroySec: number; graceSec: number; applyExpireSec: number; destroyExpireSec: number }
export function tfBudget(env: Record<string, string | undefined> = process.env): TfBudget {
  const stepSec = envNumber(env.TF_APPLY_TIMEOUT_SEC, 2700);
  const jobSec = envNumber(env.TF_JOB_BUDGET_SEC, 2700);
  const destroySec = envNumber(env.TF_DESTROY_BUDGET_SEC, 1800);
  const graceSec = envNumber(env.TF_STOP_GRACE_SEC, 1200);
  const margin = 300;
  return { stepSec, jobSec, destroySec, graceSec,
    applyExpireSec: jobSec + graceSec + destroySec + graceSec + margin,   // apply 길 + 실패 즉시 지우기
    destroyExpireSec: Math.max(3600, destroySec + graceSec + margin) };
}
