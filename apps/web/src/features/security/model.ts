import type { SecurityStatus } from '../../components/ui/Security';
import type { CellState, LedgerRow, MatrixRow, SecurityRegression, SecurityView } from '../../lib/security-types';
import type { AgentReportList } from '../../lib/types';

const CELL: Record<CellState, SecurityStatus> = { pass: 'pass', fail: 'fail', unknown: 'unknown', not_applicable: 'na', attested: 'attested' };

export type ControlRow = { id: string; title: string; source: SecurityStatus; target: SecurityStatus; reason: string };

/** 통제 한 줄에 출발과 도착 칸을 모은다. 칸이 없으면 해당 없음이다. */
export function controlRows(cells: MatrixRow[]): ControlRow[] {
  const ids = [...new Set(cells.map((cell) => cell.controlId))];
  return ids.map((id) => {
    const of = (side: MatrixRow['side']) => cells.find((cell) => cell.controlId === id && cell.side === side);
    const source = of('source');
    const target = of('target');
    return {
      id,
      title: (source ?? target)!.title,
      source: source ? CELL[source.state] : 'na',
      target: target ? CELL[target.state] : 'na',
      reason: target?.state === 'fail' ? target.reason : source?.state === 'fail' ? source.reason : '',
    };
  });
}

export function securityHeadline(view: Pick<SecurityView, 'summary'> | null, regression: Pick<SecurityRegression, 'summary' | 'verdict'> | null) {
  if (!view) return { stop: false, title: '보안 표를\n읽고 있습니다' };
  const worse = regression?.verdict === 'regressed' ? regression.summary.worse : 0;
  if (view.summary.fail > 0) return { stop: true, title: `위반 ${view.summary.fail}건을\n확인해 주세요` };
  if (worse > 0) return { stop: true, title: `옮긴 뒤 ${worse}건이\n약해집니다` };
  if (view.summary.notImplemented > 0 || view.summary.warn > 0) return { stop: false, title: '위반은 없고\n확인할 칸이 남았습니다' };
  return { stop: false, title: '통제가\n모두 지켜졌습니다' };
}

export type Threat = { key: string; title: string; severity: string; evidence: string; at: string };

/**
 * 위협 패널의 근거. 온프레 Agent가 보낸 보안 보고 중 지금 일어나는 위협(kind: threat, Falco 경보 등)의 실패 항목이다.
 * 설정 위반(kind: posture, Kyverno 정책 보고 등)은 위협이 아니라 통제 쪽 근거라 여기서 뺀다.
 */
export function threatsFrom(reports: (AgentReportList | null)[]): Threat[] {
  return reports.flatMap((list) =>
    (list?.items ?? []).flatMap((item) =>
      item.report.kind === 'security'
        ? item.report.findings
            .filter((finding) => finding.kind === 'threat' && finding.status === 'fail')
            .map((finding, index) => ({
              key: `${item.id}-${index}`,
              title: finding.resource || finding.toolCheckId || '보안 항목',
              severity: finding.severity,
              evidence: finding.evidence,
              at: item.receivedAt,
            }))
        : [],
    ),
  );
}

export type LedgerSummary = { total: number; live: number; closed: number; stale: number };

/** 임시 권한 장부를 센다. live = 지금 쓸 수 있는 것, stale = 만료 시각이 지났는데 회수 처리가 안 된 것. */
export function ledgerSummary(rows: Pick<LedgerRow, 'status' | 'expiredButActive'>[]): LedgerSummary {
  const stale = rows.filter((row) => row.expiredButActive).length;
  const live = rows.filter((row) => (row.status === 'active' || row.status === 'revoke_requested') && !row.expiredButActive).length;
  return { total: rows.length, live, closed: rows.length - live - stale, stale };
}

/** 장부 줄 순서: 예외(만료됐는데 남음) → 지금 살아 있음 → 끝난 것, 같으면 최근 발급 먼저. */
export function ledgerOrder<T extends Pick<LedgerRow, 'status' | 'expiredButActive' | 'issuedAt'>>(rows: T[]): T[] {
  const rank = (row: T) => (row.expiredButActive ? 0 : row.status === 'active' || row.status === 'revoke_requested' ? 1 : 2);
  return [...rows].sort((a, b) => rank(a) - rank(b) || b.issuedAt.localeCompare(a.issuedAt));
}

/**
 * 이전 화면 "보안" 카드의 접힌 머리줄 요약과 스스로 펼칠지.
 * 가드레일 멈춤·지금 일어나는 위협·만료됐는데 남은 권한은 사람이 바로 봐야 해서 펼친다. 위반·약점은 요약에만 쓴다.
 */
export function securityCardSummary(o: {
  view: Pick<SecurityView, 'summary' | 'ledger'> | null;
  threats: number;
  stoppedByRule: boolean;
  reading: boolean;
}): { summary: string; open: boolean } {
  const stale = o.view?.ledger ? ledgerSummary(o.view.ledger).stale : 0;
  const parts = [
    o.stoppedByRule ? '가드레일 멈춤' : null,
    o.threats > 0 ? `위협 ${o.threats}` : null,
    stale > 0 ? `만료된 권한 ${stale}` : null,
    o.view && o.view.summary.fail > 0 ? `위반 ${o.view.summary.fail}` : null,
    o.view && o.view.summary.warn > 0 ? `약점 ${o.view.summary.warn}` : null,
  ].filter((part): part is string => !!part);
  const open = o.stoppedByRule || o.threats > 0 || stale > 0;
  if (parts.length > 0) return { summary: parts.slice(0, 2).join(' · '), open };
  if (!o.view) return { summary: o.reading ? '읽는 중' : '아직 없음', open };
  return { summary: o.view.summary.notImplemented > 0 ? `미구현 ${o.view.summary.notImplemented}` : '모두 지켜짐', open };
}
