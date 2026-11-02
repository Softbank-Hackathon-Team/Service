import s from './Skeleton.module.css';

/** 읽는 동안 자리를 잡아 두는 회색 줄. 빈 카드 대신 무엇이 올지 모양으로 보인다. */
export function SkeletonRows({ count = 4 }: { count?: number }) {
  return (
    <div className={s.rows} aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <span key={index} className={s.line} style={{ width: `${88 - ((index * 17) % 40)}%` }} />
      ))}
    </div>
  );
}

/** 큰 카드의 숫자 자리. */
export function SkeletonStats({ count = 3 }: { count?: number }) {
  return (
    <div className={s.stats} aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <span key={index} className={s.stat}>
          <span className={s.number} />
          <span className={s.caption} />
        </span>
      ))}
    </div>
  );
}
