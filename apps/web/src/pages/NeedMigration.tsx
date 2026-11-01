import { hrefOf } from "../router";

// Z83-05: 이전 하나를 골라야 뜻이 있는 페이지(비용·모니터링·보안·AI)에서 아직 안 골랐을 때 한 줄.
// 빈 화면이 아니라 "어디서 고르는지"를 말한다
export function NeedMigration(p: { what: string }) {
  return (
    <div className="card">
      <p>{p.what}은 이전 한 건 기준이야. 위 "이전 고르기"에서 하나를 고르거나, <a href={hrefOf("migrations")}>이전 만들고 진행하기</a>에서 새로 만들어.</p>
    </div>
  );
}
