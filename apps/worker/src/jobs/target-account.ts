// 결정 3번 A안 (GCP 이전 전용 프로젝트): 도착 쪽에서 쓰는 "계정" 칸. 도착 자원(Terraform project_id)·사전 점검·배포는 이 값을 본다
//   GCP: environments.gcp_target_project (비면 예전처럼 account_id = 원래 프로젝트, 옛 환경). 그 밖 제공자: account_id 그대로
//   관찰(가져오기·연결 확인)은 계속 account_id(원래 프로젝트). 실행 역할 roleRef 는 platform.ts resolveEnv 가 같은 규칙으로 고른다
export const TARGET_ACCOUNT_SQL = `CASE WHEN provider = 'gcp' THEN COALESCE(gcp_target_project, account_id) ELSE account_id END`;
