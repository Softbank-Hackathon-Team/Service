/** 진짜 판(MOCK_IAC·MOCK_TRAFFIC 꺼짐)에서 설정·권한이 없어 멈출 때 detail 의 error·reason 옆(맨 위 또는 그 단계 칸 하나)에 더하는 두 칸. 웹 멈춤 화면이 그대로 그린다.
 *  missing = 빠진 것의 정확한 이름: env(`PROM_URL`) · `helm: <값>` · 도구(`terraform`) · `<aws|gcp>: <고객 권한·역할>` · DB 줄·사실(`environment_layers(gcp/env)`)
 *  hint = 무엇으로 고치나 한 문장 (helm 값·worker-env 비밀 키·고객 연결 스크립트·CLI). MOCK_* 는 "시험·로컬 흉내"로만 적는다. 비밀값·계정 번호는 넣지 않는다 */
export interface StopHint { missing: string[]; hint: string }
