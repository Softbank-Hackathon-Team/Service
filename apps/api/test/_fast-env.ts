// Z20: 통합 시험용 짧은 관찰 시간. 다른 import보다 먼저 불러야 한다 (core 가 모듈을 읽을 때 환경변수를 한 번 읽는다).
// M7 뒤 100% 관찰은 시계로 30초(기본)라, 그대로면 draft → completed 한 바퀴가 30초 넘게 늘어난다.
// TESTENV: 밖(.env·셸) 값과 상관없이 늘 0.5. 예전 ??= 는 .env 에 30 이 있으면 30 을 써서 시간 초과로 깨졌다
process.env.TRAFFIC_OBSERVE_SEC = "0.5";
export {};
