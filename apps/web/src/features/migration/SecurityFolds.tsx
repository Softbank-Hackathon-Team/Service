import { useState } from 'react';
import { FoldTile } from '../../components/layout/tiles';
import { Badge, BarPill, OptionPill } from '../../components/ui/controls';
import type { PrecheckItem } from '../../lib/types';
import {
  DATA_CLASSES, DATA_CLASS_LABEL, KEY_OWNERS, KEY_OWNER_LABEL, OPERATORS, OPERATOR_LABEL,
  draftOf, factRows, requirementRows, requirementsFrom, requirementsSummary, secGroups, secSummary,
  type RequirementsDraft, type SecurityRequirements, type SecuritySpecV2, type SourceDbFacts,
} from './securityV2';
import { ConfirmPill } from './shared';
import s from '../common/page.module.css';
import { t } from '../../lib/i18n';

type RequirementsFoldProps = {
  requirements: SecurityRequirements | null;
  /** 지금 보이는 명세 판. 고치는 중인 값은 이 판에 묶는다 */
  version: number;
  busy: boolean;
  defaultOpen: boolean;
  /** 지난 단계로 다시 볼 때: 값만 보이고 정하기·고치기·지우기를 두지 않는다 */
  readOnly?: boolean;
  /** null = 요구사항 지우기 */
  onSave: (value: SecuritySpecV2 | null) => void;
};

/**
 * 앱 보안 요구사항 (명세 v2 security). 저장하면 새 판이 하나 생긴다 (PATCH changes "security" 통째).
 * 저장해서 판이 바뀌거나 그 사이 다른 판이 생기면 고치기를 닫고 새 판의 값을 보여 준다 (사람이 본 것과 다른 판을 덮지 않게)
 */
export function RequirementsFold({ requirements, version, busy, defaultOpen, readOnly, onSave }: RequirementsFoldProps) {
  const [editing, setEditing] = useState<{ version: number; draft: RequirementsDraft } | null>(null);
  const draft = editing?.version === version ? editing.draft : null;
  const set = (next: Partial<RequirementsDraft>) => draft && setEditing({ version, draft: { ...draft, ...next } });
  const toggle = <T,>(list: T[], value: T) => (list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);
  const rows = requirementRows(requirements);

  if (draft) {
    const { requirements: next, badCountries } = requirementsFrom(draft);
    return (
      <FoldTile title={t('보안 요구사항')} summary={t('고치는 중')}>
        <div className={s.form}>
          <div className={s.field}>
            <span className="t-label-md">{t('데이터 등급')}</span>
            <div className={s.options}>
              {DATA_CLASSES.map((value) => (
                <OptionPill key={value} label={DATA_CLASS_LABEL[value]} selected={draft.dataClass === value} onClick={() => set({ dataClass: value })} />
              ))}
            </div>
          </div>
          <label className={s.field}>
            <span className="t-label-md">{t('허용 국가')}</span>
            <input
              className={`${s.input} t-body-md`}
              value={draft.residency}
              placeholder="KR, JP"
              spellCheck={false}
              aria-invalid={badCountries.length > 0 ? true : undefined}
              onChange={(event) => set({ residency: event.target.value })}
            />
            <span className="t-caption c-tertiary">{t('두 글자 국가 코드를 쉼표로 나눠 적습니다. 비우면 국가를 제한하지 않습니다')}</span>
          </label>
          {badCountries.length > 0 && <p className={`${s.error} t-body-sm`}>{t('국가 코드가 아닙니다: {0}', { 0: badCountries.join(', ') })}</p>}
          <div className={s.field}>
            <span className="t-label-md">{t('키 소유')}</span>
            <div className={s.options}>
              {KEY_OWNERS.map((value) => (
                <OptionPill key={value} label={KEY_OWNER_LABEL[value]} selected={draft.keyOwnership === value} onClick={() => set({ keyOwnership: value })} />
              ))}
            </div>
          </div>
          <div className={s.field}>
            <span className="t-label-md">{t('운영 주체')}</span>
            <div className={s.options}>
              {OPERATORS.map((value) => (
                <OptionPill
                  key={value}
                  label={OPERATOR_LABEL[value]}
                  selected={draft.operatorAllow.includes(value)}
                  onClick={() => set({ operatorAllow: toggle(draft.operatorAllow, value) })}
                />
              ))}
            </div>
            <span className="t-caption c-tertiary">{t('고르지 않으면 운영 주체를 제한하지 않습니다')}</span>
          </div>
          <div className={s.options}>
            <BarPill label={t('그만두기')} onClick={busy ? undefined : () => setEditing(null)} />
            <BarPill label={busy ? t('보내는 중') : t('저장')} icon="check" onClick={next && !busy ? () => onSave({ requirements: next }) : undefined} />
          </div>
        </div>
      </FoldTile>
    );
  }

  return (
    <FoldTile title={t('보안 요구사항')} summary={requirementsSummary(requirements)} defaultOpen={defaultOpen}>
      {rows.length > 0 ? (
        <>
          <ul className={s.rows}>
            {rows.map((row) => (
              <li key={row.name} className={s.row}>
                <span className="t-label-md">{row.name}</span>
                <span className={`${s.rowValue} t-body-sm c-secondary`}>{row.value}</span>
              </li>
            ))}
          </ul>
          <p className={`${s.note} t-caption c-tertiary`}>{t('고객이 정한 값입니다. 사전 점검이 출발·도착의 보안 사실과 맞대어 봅니다.')}</p>
        </>
      ) : (
        <p className={`${s.note} t-body-sm c-secondary`}>
          {t('데이터 등급, 허용 국가, 키 소유를 정하지 않으면 위치·키 규칙을 판정하지 못하고 계획 승인 때 고객 확인 항목이 됩니다.')}
        </p>
      )}
      {!readOnly && (
        <div className={`${s.rowAction} ${s.options}`}>
          <BarPill label={requirements ? t('고치기') : t('정하기')} icon={requirements ? 'list' : 'plus'} onClick={busy ? undefined : () => setEditing({ version, draft: draftOf(requirements) })} />
          {requirements && <ConfirmPill label={t('지우기')} confirmLabel={t('요구사항 지우기')} icon="x" disabled={busy} onConfirm={() => onSave(null)} />}
        </div>
      )}
    </FoldTile>
  );
}

/** 가져오기가 출발 DB 에서 읽은 보안 사실. 읽기 전용. 이 판에 칸이 없으면 그리지 않는다 */
export function SourceFactsFold({ facts }: { facts: Record<string, SourceDbFacts> | undefined }) {
  const view = factRows(facts);
  if (!view) return null;
  return (
    <FoldTile title={t('출발 DB 보안')} summary={view.summary} defaultOpen={false}>
      <ul className={s.rows}>
        {view.rows.map((row) => (
          <li key={row.key}>
            <div className={s.row}>
              <span className={`${s.rowName} t-label-md`}>{row.name}</span>
              {row.value === null ? <Badge tone="warning">{t('모름')}</Badge> : <span className={`${s.rowValue} t-body-sm c-secondary`}>{row.value}</span>}
            </div>
            {row.origin && <p className={`${s.rowCaption} t-caption c-tertiary`}>{row.origin}</p>}
          </li>
        ))}
      </ul>
      <p className={`${s.note} t-caption c-tertiary`}>{t('가져올 때 출발 DB에서 읽은 값입니다. 명세에서 고칠 수 없고, 모름은 통과로 보지 않습니다.')}</p>
    </FoldTile>
  );
}

/** 사전 점검의 보안 판정(SEC:*)을 단계별로. 단계마다 사람이 할 일을 한 줄로 먼저 말한다 */
export function VerdictFold({ items }: { items: readonly PrecheckItem[] }) {
  const groups = secGroups(items);
  if (groups.length === 0) return null;
  const heavy = groups.some((group) => group.level !== 'advise');
  return (
    <FoldTile key={`sec-${heavy}`} title={t('보안 판정')} summary={secSummary(groups)} defaultOpen={heavy}>
      {groups.map((group) => (
        <div key={group.level}>
          <p className={`${s.note} t-caption c-tertiary`}>{group.need}</p>
          <ul className={s.rows}>
            {group.items.map((verdict) => (
              <li key={verdict.id}>
                <div className={s.row}>
                  <span className={`${s.rowName} t-label-md`}>{verdict.title}</span>
                  <Badge tone={group.tone}>{group.label}</Badge>
                </div>
                {verdict.reason && <p className={`${s.rowCaption} t-caption c-secondary`}>{verdict.reason}</p>}
                {verdict.fix && <p className={`${s.rowCaption} t-caption c-tertiary`}>{t('조치: {0}', { 0: verdict.fix })}</p>}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </FoldTile>
  );
}
