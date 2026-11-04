import { useEffect, useState } from 'react';

/** 지금 시각 (ms). every 마다 다시 그린다. on 이 거짓이면 멈춘다 */
export function useNow(every = 1000, on = true) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), every);
    return () => window.clearInterval(timer);
  }, [every, on]);
  return now;
}
