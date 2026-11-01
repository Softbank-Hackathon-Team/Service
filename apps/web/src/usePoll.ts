import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

// SSE(GET /events)가 아직 없어서 일정 간격으로 다시 읽는다.
// - ms = null 이면 처음 한 번만 읽고 멈춘다 (끝난 이전 등)
// - deps 가 바뀌면 data·error를 비우고 처음부터 (회사 번호를 바꿨을 때 옛 값이 남지 않게)
// - loading: 첫 응답(성공이든 실패든)이 오기 전. "아직 안 옴"과 "진짜 없음"을 구분하려고 쓴다
// - keepOnError: false 면 오류가 나면 data도 비운다 (404인데 옛 내용이 남는 것 방지)
export function usePoll<T>(
  fn: (() => Promise<T>) | null,
  ms: number | null,
  deps: unknown[],
  opts: { keepOnError?: boolean } = {},
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  const keepRef = useRef(opts.keepOnError ?? true);
  // 최신 fn·옵션을 ref 에 담는다. 렌더 중에 ref 를 쓰지 않고(React useRef Pitfall) 레이아웃 효과에서 쓴다.
  // 레이아웃 효과는 아래 useEffect 들보다 먼저 돌아서, 타이머·첫 읽기는 늘 최신 fn 을 본다
  useLayoutEffect(() => {
    fnRef.current = fn;
    keepRef.current = opts.keepOnError ?? true;
  });
  const gen = useRef(0); // deps가 바뀐 뒤 늦게 온 옛 응답은 버린다
  // Z83-11: 같은 deps 안에서도 요청 순서를 센다. 간격 GET 이 떠난 뒤 버튼(POST → reload)이 먼저 답을 받으면,
  // 늦게 온 옛 GET 이 새 상태를 덮어쓴다(승인됨 → 승인 대기로 되돌아가 보임). 자기보다 새 응답이 이미 그려졌으면 버린다
  // (react.dev "You Might Not Need an Effect — Fetching data": 늦게 온 응답 무시)
  const issued = useRef(0);  // 마지막으로 보낸 요청 번호
  const applied = useRef(0); // 마지막으로 화면에 쓴 요청 번호

  const reload = useCallback(async () => {
    const f = fnRef.current;
    if (!f) return;
    const my = gen.current;
    const id = ++issued.current;
    const fresh = () => my === gen.current && id > applied.current;
    try {
      const d = await f();
      if (!fresh()) return;
      applied.current = id;
      setData(d); setError(null);
    } catch (e) {
      if (!fresh()) return;
      applied.current = id;
      setError(e);
      if (!keepRef.current) setData(null);
    } finally {
      if (my === gen.current) setLoading(false);
    }
  }, []);

  // deps 바뀜 → 비우고 한 번 읽기
  useEffect(() => {
    gen.current++; issued.current = 0; applied.current = 0;
    setData(null); setError(null); setLoading(!!fnRef.current);
    if (!fnRef.current) return;
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  // 간격. ms가 바뀌면 데이터는 그대로 두고 타이머만 바꾼다
  useEffect(() => {
    if (ms === null || !fnRef.current) return;
    const t = setInterval(() => void reload(), ms);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, ...deps]);

  return { data, error, loading, reload };
}

// 오래 걸리면 true. 로딩 표시에 "시간이 오래 걸려" 안내를 붙일 때 쓴다
export function useSlow(active: boolean, ms = 8000): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!active) return;
    const t = setTimeout(() => setSlow(true), ms);
    return () => clearTimeout(t);
  }, [active, ms]);
  return slow;
}
