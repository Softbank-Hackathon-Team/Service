import s from './Logo.module.css';
import { t } from '../../lib/i18n';

// 가칭이다 (팀 합의 전). 제품 이름이 정해지면 이 값과 index.html 의 <title> 을 바꾼다.
export const PRODUCT_NAME = 'Iron platform';

/**
 * 철골 I빔의 단면. 글자 I 로도 읽힌다.
 * DRAFT(ai): 가칭에 맞춘 임시 로고다. public/favicon.svg 가 같은 모양이라 바꾸면 둘 다 바꾼다.
 */
export function Logo() {
  return (
    <span className={s.root}>
      <svg className={s.mark} viewBox="0 0 40 40" role="img" aria-label={t('{0} 로고', { 0: PRODUCT_NAME })}>
        <rect width="40" height="40" rx="11" fill="#365FCE" />
        <path d="M11 10h18v5h-6.5v10H29v5H11v-5h6.5V15H11z" fill="#fff" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
      <span className={s.name}>{PRODUCT_NAME}</span>
    </span>
  );
}
