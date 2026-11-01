import s from './TrafficBar.module.css';

type TrafficBarProps = {
  source: string;
  target: string;
  targetPercent: number;
  surface?: 'tile' | 'hero';
};

/** 출발과 도착의 트래픽 비율. 값과 이름은 항상 막대 위에 직접 적는다. */
export function TrafficBar({ source, target, targetPercent, surface = 'tile' }: TrafficBarProps) {
  const sourcePercent = 100 - targetPercent;
  return (
    <div
      className={`${s.root} ${surface === 'hero' ? s.onHero : ''}`}
      role="img"
      aria-label={`트래픽 ${source} ${sourcePercent}%, ${target} ${targetPercent}%`}
    >
      <div className={`${s.labels} t-label-md`}>
        <span>
          {source} {sourcePercent}%
        </span>
        <span>
          {target} {targetPercent}%
        </span>
      </div>
      <div className={s.track}>
        <span
          className={s.source}
          style={{ flexGrow: sourcePercent, display: sourcePercent === 0 ? 'none' : undefined }}
          title={`${source} ${sourcePercent}%`}
        />
        <span
          className={s.target}
          style={{ flexGrow: targetPercent, display: targetPercent === 0 ? 'none' : undefined }}
          title={`${target} ${targetPercent}%`}
        />
      </div>
    </div>
  );
}
