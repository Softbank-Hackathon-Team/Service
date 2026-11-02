// 표시 메모: 환경 표 4칸(이름·계정, 클라우드, 연결·실패 이유, 마지막 검증). 시험용 환경은 접어 둔다. 비었으면 개발자용 안내(회사 번호, seed).
import type { EnvironmentView } from "../types";
import { CONN_LABEL, PROVIDER_SHORT } from "../status";
import { splitEnvs } from "../envs";
import { isApiDown } from "../api";
import { ErrorBox } from "./ErrorBox";
import { Loading } from "./Loading";
import { MockBadge } from "./MockBadge";

// 예전 경로로 가져오는 곳을 위해 남긴다 (MockBadge 는 MockBadge.tsx 로 옮김)
export { MockBadge };

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("ko-KR", { hour12: false }) : "—");

function Row({ e }: { e: EnvironmentView }) {
  const conn = CONN_LABEL[e.connectionStatus] ?? e.connectionStatus;
  return (
    <tr title={e.id}>
      <td>{e.name}{e.accountId && <div className="env-sub">{e.accountId}</div>}</td>
      <td>{PROVIDER_SHORT[e.provider] ?? e.provider} {e.provider === "azure_mock" && <MockBadge />}</td>
      <td>
        {/* 한 줄에 한 뜻: 한국어 이름만, 영어 코드는 title 로 */}
        <span className={`chip conn-${e.connectionStatus}`} title={e.connectionStatus}>{conn}</span>
        {e.failureReason && <div className="muted small">{e.failureReason}</div>}
      </td>
      <td className="muted small">{when(e.lastVerifiedAt)}</td>
    </tr>
  );
}

// Z83: 실 환경이 먼저, 시험용(load-·e2e-·test- 접두) 환경은 기본 접힘 (부하 시험이 만든 20개가 실 환경 4개를 묻던 문제)
export function Environments(p: { envs: EnvironmentView[]; loading: boolean; error: unknown }) {
  const empty = !p.loading && !p.error && p.envs.length === 0;
  const { real, test } = splitEnvs(p.envs);
  return (
    <div className="card">
      <div className="card-head">
        <h2>환경</h2>
        {p.envs.length > 0 && <span className="mcount">실 {real.length}{test.length > 0 && ` · 시험용 ${test.length}`}</span>}
      </div>
      {/* API 끊김은 맨 위 띠가 말한다. 여기서는 환경 목록 자체의 오류(404·500)만 */}
      {!isApiDown(p.error) && <ErrorBox error={p.error} />}
      <table className="tbl env-tbl">
        <thead><tr><th>이름</th><th>클라우드</th><th>연결</th><th>마지막 검증</th></tr></thead>
        <tbody>
          {real.map((e) => <Row key={e.id} e={e} />)}
          {real.length === 0 && test.map((e) => <Row key={e.id} e={e} />)}
          {p.loading && p.envs.length === 0 && <tr><td colSpan={4}><Loading /></td></tr>}
          {empty && <tr><td colSpan={4} className="muted">환경 없음</td></tr>}
        </tbody>
      </table>
      {real.length > 0 && test.length > 0 && (
        <details className="env-test">
          <summary>시험용 환경 {test.length}개 (부하 시험·e2e 가 만든 것) 펼치기</summary>
          <table className="tbl env-tbl">
            <tbody>{test.map((e) => <Row key={e.id} e={e} />)}</tbody>
          </table>
        </details>
      )}
      {empty && (
        <div className="note">
          이 회사 번호로 연결된 클라우드가 하나도 안 보여. 다음 중 하나를 확인해:
          <ul className="hint">
            <li>위쪽 회사 번호가 맞는지 (개발 seed 회사는 <code>11111111-…-111111111111</code>)</li>
            <li>로컬 DB에 seed가 들어갔는지 (<code>npm run db:reset</code>)</li>
            <li>계정 연결 화면은 아직 없어. 지금은 seed 환경(dev-aws, dev-gcp)으로 시연해</li>
          </ul>
        </div>
      )}
    </div>
  );
}
