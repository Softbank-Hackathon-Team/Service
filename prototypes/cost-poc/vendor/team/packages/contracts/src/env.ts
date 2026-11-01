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
