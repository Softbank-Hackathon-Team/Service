import { Icon, type IconName } from './Icon';
import s from './Timeline.module.css';

export type TimelineKind = 'tool' | 'denied' | 'pass' | 'fail' | 'guardrail' | 'human' | 'system';

export type TimelineEntry = {
  kind: TimelineKind;
  title: string;
  detail: string;
  time: string;
  /** 서버가 남긴 이유 한 줄 (실패 줄의 detail.error 등). 글자 그대로 그린다 */
  note?: string | null;
};

const KIND_ICON: Record<TimelineKind, IconName> = {
  tool: 'bot',
  denied: 'ban',
  pass: 'check',
  fail: 'x',
  guardrail: 'shield',
  human: 'user-check',
  system: 'git-pr',
};

/** 감사 로그와 에이전트 기록. 거부된 호출도 지우지 않고 남긴다. */
export function Timeline({ items }: { items: TimelineEntry[] }) {
  return (
    <ol className={s.list}>
      {items.map((item, index) => (
        <li key={`${index}-${item.title}`} className={s.item}>
          <span className={`${s.mark} ${s[item.kind]}`}>
            <Icon name={KIND_ICON[item.kind]} />
          </span>
          <div className={s.body}>
            <div className={s.head}>
              <span className="t-label-md">{item.title}</span>
              <span className="t-caption c-tertiary">{item.time}</span>
            </div>
            <p className="t-code-sm c-secondary">{item.detail}</p>
            {item.note && <p className={`${s.note} t-body-sm c-secondary`}>{item.note}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}
