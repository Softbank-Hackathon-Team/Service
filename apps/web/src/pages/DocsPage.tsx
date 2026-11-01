import { API_BASE } from "../api";

// Z83-05: "API 문서 보기". 서버가 Zod 스키마로 만든 OpenAPI 문서(GET /api/v1/docs, DOCS_PUBLIC 기본 공개)를 그대로 끼워 넣는다.
// 화면은 /api/… 로만 부르고 Vite(개발)·nginx(운영)가 /api/v1 로 넘긴다 (vite.config.ts)
export function DocsPage() {
  const docs = `${API_BASE}/docs`;
  return (
    <div className="page pg-docs">
      <div className="card">
        <div className="card-head">
          <h3>OpenAPI 문서</h3>
          <span className="small">
            <a href={docs} target="_blank" rel="noopener">새 탭에서 열기</a> · <a href={`${docs}/openapi.json`} target="_blank" rel="noopener">openapi.json</a> · <a href={`${docs}/openapi.yaml`} target="_blank" rel="noopener">openapi.yaml</a>
          </span>
        </div>
        <iframe className="docs-frame" src={docs} title="API 문서" />
        <p className="muted small">문서가 비어 보이면 API 서버가 꺼졌거나 DOCS_PUBLIC=false 로 떠 있는 거야. 그때는 위 "새 탭에서 열기"로 응답 코드를 확인해.</p>
      </div>
    </div>
  );
}
