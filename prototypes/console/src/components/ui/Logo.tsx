import s from './Logo.module.css';

// DRAFT(ai): 프로토타입용 가칭이다. 제품 이름이 정해지면 이 파일만 바꾼다.
export function Logo() {
  return (
    <span className={s.root}>
      <span className={s.name}>kross</span>
      <span className={s.sub}>AI Console</span>
    </span>
  );
}
