#!/usr/bin/env bash
# 발표 당일 탭 9개를 장면 순서대로 미리 연다 (z75-49, 작업 Z78, 9차 새 화면용). 표: parallel/Z78/SCENES.md
#   bash tools/open-tabs.sh            맥: 기본 브라우저로 연다 (open). 그 밖: 주소만 찍는다
#   bash tools/open-tabs.sh --print    열지 않고 순서·주소만 찍는다
# WEB_URL(기본 http://localhost:8080 운영 빌드), GRAFANA_URL(기본 http://localhost:3001). 이전 하나가 필요한 페이지는
# 화면이 기억한 이전(localStorage web.selected)을 쓴다 → 열기 전에 리허설(또는 S1) 로 이전을 한 번 고른다
set -u
cd "$(dirname "$0")/.." || exit 1
WEB=${WEB_URL:-http://localhost:8080}
GRAF=${GRAFANA_URL:-http://localhost:3001}
PRINT=0; [ "${1:-}" = --print ] && PRINT=1
TABS="1|S0·S8 설계 문서 (1절 그림, 2-3절 숫자 표)|$(pwd)/docs/archive/DESIGN-FINALS.md
2|S0 한눈에 보기|$WEB/#/dashboard
3|S1·S4 이전 만들고 진행하기|$WEB/#/
4|S5 비용 비교하기 (질문 대비)|$WEB/#/cost
5|S5 모니터링 보기 (질문 대비)|$WEB/#/monitoring
6|S6 보안·감사 확인하기|$WEB/#/security
7|S7 AI 점검 돌리기|$WEB/#/agent
8|질문 대비 API 문서 보기|$WEB/#/docs
9|질문 대비 Grafana|$GRAF/"
echo "$TABS" | while IFS='|' read -r n what url; do
  printf '%s. %s  %s\n' "$n" "$what" "$url"
  if [ "$PRINT" = 0 ] && [ "$(uname -s)" = Darwin ]; then open "$url"; sleep 0.3; fi
done
