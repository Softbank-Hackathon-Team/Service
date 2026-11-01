import type { MigrationView } from "../types";
import { HUMAN_STEP, LABEL, MAIN_PATH, anchorOf, toneOf } from "../status";
import { StatusChip } from "./StatusChip";

// 정상 경로 15칸 레일. 지나간 칸은 초록 윗선, 지금 칸만 두꺼운 윗선, 남은 칸은 흐리게.
// 비정상 상태(paused·failed·rejected·stale)는 멈춘 칸에 상태 칩을 붙인다
export function Stepper({ m }: { m: MigrationView }) {
  const anchor = anchorOf(m);
  const cur = anchor ? MAIN_PATH.indexOf(anchor) : -1;
  const offPath = !MAIN_PATH.includes(m.status);
  const tone = toneOf(m.status);

  return (
    <div>
      <ol className="stepper" aria-label={`진행 단계 ${MAIN_PATH.length}칸, 지금 ${LABEL[m.status]}`}>
        {MAIN_PATH.map((s, i) => {
          let cls = "todo";
          if (i < cur || m.status === "completed") cls = "done";
          else if (i === cur) cls = `here tone-${tone}`;
          return (
            <li key={s} className={cls} title={s} aria-current={i === cur ? "step" : undefined}>
              <span className="num">{String(i + 1).padStart(2, "0")}</span>
              <span className="lbl">{LABEL[s]}{HUMAN_STEP.includes(s) && <em> 사람</em>}</span>
              {i === cur && offPath && <StatusChip status={m.status} />}
            </li>
          );
        })}
      </ol>
      {offPath && cur < 0 && (
        <p className="note">지금 상태 <b>{LABEL[m.status]}</b>({m.status})는 정상 경로 밖이야. 어느 칸에서 왔는지는 아래 타임라인에서 확인해.</p>
      )}
    </div>
  );
}
