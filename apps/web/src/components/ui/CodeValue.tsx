import { useState } from 'react';
import { middleEllipsis } from '../../lib/text';
import { Icon } from './Icon';
import s from './CodeValue.module.css';
import { t } from '../../lib/i18n';

type CodeValueProps = {
  value: string;
  max?: number;
  chip?: boolean;
  size?: 'sm' | 'md';
  className?: string;
};

/** 고정폭 값. 길면 한 줄로 가운데를 줄이고, 전체 값은 툴팁과 복사 버튼으로 닿는다. */
export function CodeValue({ value, max = 28, chip, size = chip ? 'md' : 'sm', className = '' }: CodeValueProps) {
  const [copied, setCopied] = useState(false);
  const long = value.length > max;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // 복사를 막은 브라우저에서는 툴팁으로 전체 값을 본다
    }
  };
  return (
    <span className={`${s.root} ${chip ? s.chip : ''} ${className}`}>
      <code className={`${s.text} t-code-${size}`} title={long ? value : undefined}>
        {middleEllipsis(value, max)}
      </code>
      {long && (
        <button type="button" className={s.copy} aria-label={copied ? t('복사했습니다') : t('전체 값 복사')} onClick={() => void copy()}>
          <Icon name={copied ? 'check' : 'copy'} size={14} />
        </button>
      )}
    </span>
  );
}
