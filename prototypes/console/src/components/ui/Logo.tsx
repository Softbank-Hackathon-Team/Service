import s from './Logo.module.css';

// DRAFT(ai): 프로토타입용 가칭과 임시 로고다. 제품 이름이 정해지면 이 파일만 바꾼다.
const PRODUCT_NAME = 'Kross AI';

/** 두 경로가 만나 건너가는 모양. 디자인 토큰과 무관한 브랜드 색을 쓴다. */
export function Logo() {
  return (
    <span className={s.root}>
      <svg className={s.mark} viewBox="0 0 40 40" role="img" aria-label={`${PRODUCT_NAME} 로고`}>
        <defs>
          <linearGradient id="kross-mark" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#4F46E5" />
            <stop offset="1" stopColor="#0EA5E9" />
          </linearGradient>
        </defs>
        <rect width="40" height="40" rx="11" fill="url(#kross-mark)" />
        <path d="M12 10v20" stroke="#fff" strokeWidth="4" strokeLinecap="round" />
        <path d="M28 10 17.5 20 28 30" fill="none" stroke="#fff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="28" cy="20" r="2.5" fill="#fff" />
      </svg>
      <span className={s.name}>{PRODUCT_NAME}</span>
    </span>
  );
}
