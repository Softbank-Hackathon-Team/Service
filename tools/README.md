# tools — 운영 도구 메모

상태: AI 초안

도구마다 사용법은 파일 머리 주석이 기준이다. 여기에는 실제 플랫폼을 건드리는 도구 중 여러 사람이 같이 쓰는 것만 짧게 적는다.

## 실제 플랫폼 회사에 팀원 로그인 만들기 (`platform-team-users.sh`)

가입·초대 API 가 없어서, 한 회사(테넌트)에 이메일+비밀번호 계정 여러 개를 도구로 만든다. DB 에 닿는 길은 `platform-db-migrate.sh` 와 같다(EKS `platform` 네임스페이스의 임시 postgres 파드, 표 주인 연결은 RDS 관리 비밀 → k8s Secret, 끝나면 파드·Secret 삭제).

```bash
# 레포 루트, npm ci 를 한 뒤. 먼저 모양만 본다 (비밀값·AWS·kubectl 없음)
DRY_RUN=1 TENANT_ID=<회사 uuid> bash tools/platform-team-users.sh team.txt
# 실제로 넣는다 (team.txt: 한 줄에 "email:이름", 인자로 "email:이름" 을 직접 줘도 된다)
TENANT_ID=<회사 uuid> bash tools/platform-team-users.sh team.txt
```

- 비밀번호(24자 무작위)는 이 맥에서 만들고 앱의 `hashPassword`(운영과 같은 scrypt N=2^17)로 해시한다. DB 로는 해시만, `kubectl exec` 표준 입력으로 간다(프로세스 인자에 없음).
- 원문은 `OUT_FILE`(기본 `~/.config/iron/team-logins.txt`, 권한 600)에 `email<TAB>password` 로만 남는다. 각자에게 따로 전한다. 화면에는 `email → created | exists` 와 합계만 나온다.
- 한 트랜잭션: `INSERT … ON CONFLICT (email) DO NOTHING`. 회사가 없으면 아무것도 안 넣고 멈춘다. 이메일은 플랫폼 전체에서 하나라, 다른 회사가 쓰는 이메일은 `exists (다른 회사 계정)` 로 건너뛴다.
- 다시 돌려도 된다: 파일에 이미 있는 이메일은 같은 비밀번호를 쓴다. `FORCE=1` 이면 새 비밀번호를 만들고 같은 회사의 기존 계정 비밀번호를 바꾼다(`reset`).
- 이번에 새로 만든 비밀번호인데 이미 있던 계정(`exists`)이면 그 줄은 파일에서 뺀다(맞지 않는 비밀번호를 남기지 않는다).
- 셸에 시험용 `AUTH_SCRYPT_N`(16384)이 남아 있으면 약한 해시가 운영에 들어가므로 멈춘다. 비우고 다시 돌린다.
- 기본값: `KUBE_CONTEXT=eks-platform`, `AWS_PROFILE=softbank`, `AWS_REGION=ap-northeast-2`.
- 계정 끄기는 `npm run auth:seed -- --disable <이메일> --tenant <uuid>` (`OWNER_DATABASE_URL` 이 닿는 곳에서).
