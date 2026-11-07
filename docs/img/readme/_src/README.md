# README 도표 원본

`flow.html`, `gitops.html` 은 `docs/img/readme/flow.png`, `gitops-flow.png` 의 원본이다.
글꼴은 Pretendard(OFL)를 `fonts/` 에 두고 렌더한다 (레포에는 글꼴 파일을 넣지 않았다).

```bash
node render.mjs "$PWD/flow.html" ../flow.png 1900
node render.mjs "$PWD/gitops.html" ../gitops-flow.png 1900
```

나머지 그림(architecture-v0.6, platform-infra, onprem-db-tunnel)은 노션 설계 문서와 팀 공유 폴더의 기존 그림을 그대로 옮겼다.
