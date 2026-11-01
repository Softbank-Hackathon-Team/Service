# 앱 Helm 차트 사본 (CI 검사용)

- Z66: 차트 원본은 **gitops 레포 `charts/app`** 하나다. 워커(`tools/render.mjs`)와 Argo CD가 실제로 읽는 곳이 거기다.
- 이 폴더는 `deploy/ci/check-gitops.sh`가 어댑터 값 5벌로 렌더·스키마 검사하려고 둔 사본이다. 고칠 때는 gitops 레포를 먼저 고치고 여기로 복사한다.
- `GITOPS_REPO_DIR`가 있으면 CI가 두 사본을 `diff -r`로 비교해서 다르면 실패한다.
