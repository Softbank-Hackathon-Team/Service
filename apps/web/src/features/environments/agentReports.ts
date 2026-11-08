import type { AgentDeployProgress, AgentReportBody } from '../../lib/types';
import { t } from '../../lib/i18n';

// 온프레 Agent 보고(contracts agent.ts AgentReport)를 사람 말 한 줄로. 시험은 test/agent-reports.test.ts
// deploy 보고: applied = 반영됨, failed = 실패(이유), progressing = 아직 뜨는 중 (#377, progress 에 Argo 상태). 진행 중은 실패처럼 보이지 않게 중립 문장

/** 진행 중 deploy 보고 한 줄: Argo 동기화/건강 상태, 그 뒤에 기다리는 자원(없으면 Argo 메시지) */
export function progressLine(progress: AgentDeployProgress | undefined): string {
  if (!progress) return t('배포 진행 중');
  const wait = progress.waitingOn;
  const tail = wait ? t('기다리는 자원 {0}', { 0: wait.health ? `${wait.resource} (${wait.health})` : wait.resource }) : progress.message;
  return t('배포 진행 중 · {0}', { 0: [`${progress.sync}/${progress.health}`, tail].filter(Boolean).join(' · ') });
}

/** 온프레 Agent 보고 한 줄 (환경 화면 "온프레 Agent 보고" 카드) */
export function reportLine(report: AgentReportBody) {
  if (report.kind === 'heartbeat') return `k3s ${report.k3sVersion}${report.cnpg ? ` · DB ${report.cnpg.ready ? t('준비됨') : t('준비 안 됨')}` : ''}`;
  if (report.kind === 'deploy') {
    if (report.status === 'progressing') return progressLine(report.progress);
    return report.status === 'applied' ? t('배포 적용 · 자원 {0}개', { 0: report.resources.length }) : t('배포 실패{0}', { 0: report.reason ? ` · ${report.reason}` : '' });
  }
  if (report.kind === 'facts') {
    const tls = report.dbs.filter((db) => db.tlsEnforced === false).length;
    const open = report.dbs.filter((db) => db.exposed === true).length;
    // 영어 단수·복수는 자리 0 으로 고르므로 DB 수를 {0} 에 둔다
    return t('보안 사실 · 권한 {1} · DB {0}개 (TLS 강제 아님 {2}, 밖에 열림 {3})', { 0: report.dbs.length, 1: report.grants.level, 2: tls, 3: open });
  }
  const failed = report.findings.filter((finding) => finding.status === 'fail');
  const threats = failed.filter((finding) => finding.kind === 'threat').length;
  return t('보안 보고 · 위반 {0}개 · 위협 {1}개', { 0: failed.length - threats, 1: threats });
}
