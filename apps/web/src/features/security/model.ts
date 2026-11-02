import type { SecurityStatus } from '../../components/ui/Security';
import type { CellState, MatrixRow, SecurityRegression, SecurityView } from '../../lib/security-types';
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

export type Threat = { key: string; title: string; severity: string; at: string };

/** 위협 패널의 근거. 지금은 온프레 Agent가 보낸 보안 보고 중 실패한 항목이다. */
export function threatsFrom(reports: (AgentReportList | null)[]): Threat[] {
  return reports.flatMap((list) =>
    (list?.items ?? []).flatMap((item) =>
      item.report.kind === 'security'
        ? item.report.findings
            .filter((finding) => finding.status === 'fail')
            .map((finding, index) => ({
              key: `${item.id}-${index}`,
              title: finding.resource ?? finding.toolCheckId ?? '보안 항목',
              severity: finding.severity ?? 'unknown',
              at: item.receivedAt,
            }))
        : [],
    ),
  );
}
