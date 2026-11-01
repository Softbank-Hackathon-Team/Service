import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { confirmText, emergencyState } from "../emergency";
import type { MigrationView } from "../types";
import { ReasonInput } from "./ReasonInput";

type Kind = "rollback" | "cancel";

// 비상 버튼 둘. 누르면 바로 보내지 않고 확인 상자를 한 번 띄운다.
// run: MigrationDetail 의 버튼 실행기(바쁨 표시·오류 상자·한 줄 결과를 같은 방식으로 쓴다)
export function EmergencyActions(p: {
  m: MigrationView;
  busy: string | null;
  run: (name: string, f: () => Promise<unknown>) => () => Promise<void>;
}) {
  const st = emergencyState(p.m);
  const [open, setOpen] = useState<Kind | null>(null);
  const [reason, setReason] = useState("");
  // 키보드 흐름 (WAI-ARIA APG Dialog 패턴): 열리면 확인 상자 첫 칸(사유)에 초점, Esc 로 닫기, 닫히면 누른 버튼으로 초점 되돌리기
  const rollbackBtn = useRef<HTMLButtonElement>(null);
  const cancelBtn = useRef<HTMLButtonElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const lastOpen = useRef<Kind | null>(null);
  useEffect(() => {
    if (open) {
      lastOpen.current = open;
      boxRef.current?.querySelector<HTMLInputElement>("input")?.focus();
    } else if (lastOpen.current) {
      const btn = lastOpen.current === "rollback" ? rollbackBtn.current : cancelBtn.current;
      lastOpen.current = null;
      // 버튼이 꺼졌으면(상태가 바뀜) 초점을 옮기지 않는다
      if (btn && !btn.disabled) btn.focus();
    }
  }, [open]);
  const close = () => { setOpen(null); setReason(""); };

  // 확인 상자를 연 사이에 상태가 바뀌어 더는 못 누르게 되면 닫는다 (낡은 확인 방지)
  const openAllowed = open === "rollback" ? st.rollback.allowed : open === "cancel" ? st.cancel.allowed : true;
  useEffect(() => { if (!openAllowed) setOpen(null); }, [openAllowed]);

  if (!st.show) return null;

  const send = (kind: Kind) => {
    const r = reason.trim() || undefined;
    const f = kind === "rollback"
      ? () => api.rollback(p.m.id, r)
      : () => api.cancel(p.m.id, r, st.cancel.needsCleanupConfirm ? true : undefined);
    return async () => { setOpen(null); setReason(""); await p.run(kind === "rollback" ? "롤백" : "취소", f)(); };
  };

  return (
    <div className="emergency">
      <div className="actions">
        <button ref={rollbackBtn} className="danger" disabled={!st.rollback.allowed || !!p.busy || open !== null}
          title={st.rollback.why ?? undefined} onClick={() => setOpen("rollback")}>
          롤백 (출발로 되돌리기)
        </button>
        <button ref={cancelBtn} className="ghost-danger" disabled={!st.cancel.allowed || !!p.busy || open !== null}
          title={st.cancel.why ?? undefined} onClick={() => setOpen("cancel")}>
          취소
        </button>
      </div>
      {!open && (
        <ul className="muted small why-off">
          {st.rollback.why && <li>롤백: {st.rollback.why}</li>}
          {st.cancel.why && <li>취소: {st.cancel.why}</li>}
        </ul>
      )}
      {open && (
        <div className="confirm" role="alertdialog" ref={boxRef}
          aria-label={open === "rollback" ? "롤백 확인" : "취소 확인"} aria-describedby="emergency-confirm-text"
          onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } }}>
          <p id="emergency-confirm-text">{confirmText(open, p.m.status)}</p>
          <div className="actions">
            <ReasonInput value={reason} onChange={setReason} label={open === "rollback" ? "롤백 사유 (선택)" : "취소 사유 (선택)"} />
            <button className="danger" onClick={send(open)}>{open === "rollback" ? "롤백 확인" : "취소 확인"}</button>
            <button onClick={close}>그만두기</button>
          </div>
        </div>
      )}
    </div>
  );
}
