import { useState } from 'react';
import { SCREEN_GROUPS } from '../features/migration/flow';
import type { MigrationFlow } from '../features/migration/useMigrationFlow';
import s from './PrototypeMenu.module.css';

/** 프로토타입 검토용 화면 이동. 제품에 들어가는 조작이 아니므로 옮길 때 이 파일만 빼면 된다. */
export function PrototypeMenu({ flow }: { flow: MigrationFlow }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={s.root}>
      <button type="button" className={`${s.toggle} t-caption`} aria-expanded={open} onClick={() => setOpen(!open)}>
        프로토타입 화면
      </button>
      {open && (
        <div className={s.panel}>
          {SCREEN_GROUPS.map((group) => (
            <div key={group.title} className={s.group}>
              <span className={`${s.groupTitle} t-caption`}>{group.title}</span>
              {group.screens.map(({ id, label }) => (
                <button
                  key={id}
                  type="button"
                  className={`${s.item} ${flow.screen === id ? s.current : ''} t-label-sm`}
                  onClick={() => flow.jump(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          ))}
          <label className={`${s.auto} t-caption`}>
            <input type="checkbox" checked={flow.state.autoplay} onChange={flow.toggleAutoplay} />
            자동 진행
          </label>
        </div>
      )}
    </div>
  );
}
