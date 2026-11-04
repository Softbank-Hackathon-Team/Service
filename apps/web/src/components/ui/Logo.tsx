import s from './Logo.module.css';

// 가칭이다 (팀 합의 전). 제품 이름이 정해지면 이 값과 index.html 의 <title> 을 바꾼다. 로고 모양은 임시다.
export const PRODUCT_NAME = 'Iron platform';

/** 세로 막대와 꺾쇠가 만나는 모양. */
export function Logo() {
  return (
    <span className={s.root}>
      <svg className={s.mark} viewBox="0 0 40 40" role="img" aria-label={`${PRODUCT_NAME} 로고`}>
        <rect width="40" height="40" rx="11" fill="#365FCE" />
        <path d="M12 10v20" stroke="#fff" strokeWidth="4" strokeLinecap="round" />
        <path d="M28 10 17.5 20 28 30" fill="none" stroke="#fff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className={s.name}>{PRODUCT_NAME}</span>
    </span>
  );
}
