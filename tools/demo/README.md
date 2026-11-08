# tools/demo — 시연 운영 도구

상태: AI 초안

결선 시연(AWS → GCP, AWS → 온프레 동시 이전)을 준비하고, 걸린 시간을 재고, 막힌 곳을 고칠 때 쓴 도구다.
플랫폼 코드가 아니라 운영자가 노트북에서 돌리는 스크립트다. 처음 보는 사람은 `HANDOFF-demo.md` 부터 읽는다.

| 파일 | 하는 일 |
|---|---|
| `HANDOFF-demo.md` | 지금 시연 환경 상태, 다시 시연하는 순서, 알려진 빈칸 |
| `RUNBOOK.md`, `RUNBOOK-concurrent.md` | 한 방향 / 두 방향 동시 이전을 재는 순서 |
| `migration-timing.sh`, `timing_report.py` | 플랫폼 DB 를 읽기 전용으로 읽어 단계별 시간 표를 만든다 (`runs/` 에 저장) |
| `reset-roundtrip.sh` | 다시 돌리기 전 출발 DB·VM·Cloudflare·도착 EKS 를 점검하고 초기화한다 |
| `gcp-secret-filler.sh` | GCP 도착의 빈 앱 비밀 그릇을 출발 값으로 채운다 (고객 도구 역할, 값은 출력하지 않는다) |
| `vm-fix-dns.sh`, `vm-fix-ip.sh` | 온프레 VM 에서 sudo 로 실행. DNS 를 공용 DNS 로 고정하고, k3s 노드 IP 를 고정한다 |
| `sql/` | 시연용 환경 숨김·이름 되돌리기, 울타리 해제 등 플랫폼 DB 손 작업 |
| `demo-hide-backup.tsv` | 숨김 처리 전 환경 이름 백업 (`sql/demo-unhide.sql` 이 이것으로 되돌린다) |
| `runs/` | 실제 이전 측정 보고서 |

비밀 값(토큰, 비밀번호)은 어떤 파일에도 없다. 스크립트는 값을 임시 파일(0600)이나 파이프로만 넘긴다.
