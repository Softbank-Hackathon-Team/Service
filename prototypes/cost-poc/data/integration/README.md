# 시스템 접합 검증 (스크래치 사본에서만 실행)

팀 레포 origin/main(`vendor/team/COMMIT`)의 사본에 `npm ci` 한 뒤, 사본의 `apps/api/src/routes/cost-cache.ts`에서
`estimateCost` 대신 `src/adapter/team.ts`의 `estimateViaKross`를 쓰게 한 줄 바꿔 `zz-kross-route.test.ts.txt`와 기존 시험을 돌린 기록이다.
팀 레포 체크아웃은 건드리지 않았다. 결과는 `result.txt`.
