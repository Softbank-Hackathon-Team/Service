import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { PRECHECK_ITEMS, ROLLBACK_STEPS, CLEANUP_STEPS, type EnvId } from './mock';
import {
  initialState,
  isMigrationScreen,
  OBSERVE_SECONDS,
  presetFor,
  ROLLBACK_WINDOW_SECONDS,
  SCREEN_IDS,
  type MigrationState,
  type NavTab,
  type RollbackCause,
  type ScreenId,
} from './flow';

// 진행을 보여 주려고 기다리는 시간은 어디서든 1초를 넘기지 않는다.
const WAIT_MS = 800;
const CHECKLIST_TOTAL_MS = 600;
/** 체크리스트 화면은 항목이 몇 개든 화면 전체가 1초 안에 끝난다. */
const checklistTick = (items: unknown[]) => CHECKLIST_TOTAL_MS / (items.length + 1);

const parseHash = (): ScreenId => {
  const id = window.location.hash.replace('#/', '');
  return SCREEN_IDS.find((screen) => screen === id) ?? 'login';
};

const startState = (screen: ScreenId): MigrationState => ({
  ...initialState,
  ...presetFor(screen),
  migrationScreen: isMigrationScreen(screen) ? screen : initialState.migrationScreen,
});

const pendingUpdates: (() => void)[] = [];

/**
 * 지원되는 브라우저에서는 타일이 새 자리로 움직이고, 아니면 바로 바뀐다.
 * 전환이 겹치면 콜백이 늦거나 순서 없이 불릴 수 있어서, 먼저 불린 콜백이 쌓인 변경을 순서대로 모두 적용한다.
 */
const withTransition = (update: () => void) => {
  pendingUpdates.push(update);
  const applyPending = () => flushSync(() => pendingUpdates.splice(0).forEach((apply) => apply()));
  // 탭이 가려져 있으면 전환 콜백이 다시 보일 때까지 밀릴 수 있어서 바로 적용한다.
  if (!document.startViewTransition || document.hidden) {
    applyPending();
    return;
  }
  // 연달아 누르거나 탭이 가려지면 애니메이션만 건너뛴다.
  document.startViewTransition(applyPending).ready.catch(() => {});
};

/**
 * 이전 한 건의 상태와 화면 이동. 지금은 타이머로 진행을 흉내 낸다.
 * 실제 연동 때는 타이머 자리를 폴링(SSE가 생기면 SSE) 응답으로 바꾸면 되고, 화면은 그대로 둔다.
 */
export function useMigrationFlow() {
  const [screen, setScreen] = useState<ScreenId>(parseHash);
  const [state, setState] = useState<MigrationState>(() => startState(parseHash()));
  const screenRef = useRef(screen);

  const patch = useCallback((next: Partial<MigrationState>) => setState((prev) => ({ ...prev, ...next })), []);

  const go = useCallback(
    (next: ScreenId, changes: Partial<MigrationState> = {}) => {
      screenRef.current = next;
      window.location.hash = `#/${next}`;
      withTransition(() => {
        patch(isMigrationScreen(next) ? { ...changes, migrationScreen: next } : changes);
        setScreen(next);
      });
    },
    [patch],
  );

  /** 프로토타입 메뉴용. 자동 진행 없이 그 화면에 멈춰 둔다. */
  const jump = useCallback((next: ScreenId) => go(next, { ...presetFor(next), autoplay: false }), [go]);

  useEffect(() => {
    const onHashChange = () => {
      const next = parseHash();
      if (next === screenRef.current) return;
      screenRef.current = next;
      withTransition(() => {
        patch({
          ...presetFor(next),
          autoplay: false,
          ...(isMigrationScreen(next) ? { migrationScreen: next } : {}),
        });
        setScreen(next);
      });
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [patch]);

  const onRunning = screen === 'running' || screen === 'noMetrics';

  useEffect(() => {
    if (!onRunning || !state.autoplay) return;
    const timer = window.setTimeout(() => {
      switch (state.stage) {
        case 'provisioning':
          return patch({ stage: 'deploying' });
        case 'deploying':
          return patch({ stage: 'syncing' });
        case 'syncing':
          return patch({ stage: 'shifting', traffic: 0 });
        case 'shifting':
          if (state.traffic === 0) return patch({ traffic: 10 });
          if (state.traffic === 10) return state.guardrailCleared ? patch({ traffic: 50 }) : go('paused');
          if (state.traffic === 50) return patch({ traffic: 100, stage: 'observing', observeSeconds: OBSERVE_SECONDS });
          return patch({ stage: 'observing', observeSeconds: OBSERVE_SECONDS });
        case 'observing':
          return state.observeSeconds > 10
            ? patch({ observeSeconds: state.observeSeconds - 10 })
            : patch({ stage: 'cutover' });
        case 'cutover':
          return go('window', { windowSeconds: ROLLBACK_WINDOW_SECONDS });
      }
    }, WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [onRunning, state.autoplay, state.stage, state.traffic, state.observeSeconds, state.guardrailCleared, patch, go]);

  useEffect(() => {
    if (screen !== 'window') return;
    const timer = window.setInterval(() => {
      setState((prev) => ({ ...prev, windowSeconds: Math.max(0, prev.windowSeconds - 1) }));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [screen]);

  // 대기 시간이 끝나면 사람이 누르지 않아도 정리로 넘어간다. 정리를 시작하면 되돌릴 수 없다.
  useEffect(() => {
    if (screen === 'window' && state.autoplay && state.windowSeconds === 0) go('cleanup', { cleanupStep: 0 });
  }, [screen, state.autoplay, state.windowSeconds, go]);

  useEffect(() => {
    if (screen !== 'precheck' || !state.autoplay) return;
    const timer = window.setTimeout(() => {
      if (state.precheckStep < PRECHECK_ITEMS.length) patch({ precheckStep: state.precheckStep + 1 });
      else go('approve');
    }, checklistTick(PRECHECK_ITEMS));
    return () => window.clearTimeout(timer);
  }, [screen, state.autoplay, state.precheckStep, patch, go]);

  useEffect(() => {
    if ((screen !== 'rollingBack' && screen !== 'autoRollback') || !state.autoplay) return;
    const timer = window.setTimeout(() => {
      if (state.rollbackStep < ROLLBACK_STEPS.length) patch({ rollbackStep: state.rollbackStep + 1 });
      else go('rolledBack', { traffic: 0 });
    }, checklistTick(ROLLBACK_STEPS));
    return () => window.clearTimeout(timer);
  }, [screen, state.autoplay, state.rollbackStep, patch, go]);

  useEffect(() => {
    if (screen !== 'cleanup' || !state.autoplay) return;
    const timer = window.setTimeout(() => {
      if (state.cleanupStep < CLEANUP_STEPS.length) patch({ cleanupStep: state.cleanupStep + 1 });
      else go('done');
    }, checklistTick(CLEANUP_STEPS));
    return () => window.clearTimeout(timer);
  }, [screen, state.autoplay, state.cleanupStep, patch, go]);

  useEffect(() => {
    if (state.merge !== 'detecting') return;
    const timer = window.setTimeout(() => withTransition(() => patch({ merge: 'merged' })), WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [state.merge, patch]);

  useEffect(() => {
    const env = state.connecting;
    if (!env) return;
    const timer = window.setTimeout(() => {
      setState((prev) => ({ ...prev, connecting: null, connected: { ...prev.connected, [env]: true } }));
      if (screenRef.current === 'connect') go('read');
    }, WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [state.connecting, go]);

  useEffect(() => {
    if (state.agentRun !== 'running') return;
    const timer = window.setTimeout(() => patch({ agentRun: 'done' }), WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [state.agentRun, patch]);

  return useMemo(
    () => ({
      screen,
      state,
      go,
      jump,
      openTab: (tab: NavTab) => go(tab === 'migration' ? state.migrationScreen : tab),
      patch,
      setSource: (source: EnvId) =>
        setState((prev) => ({
          ...prev,
          source,
          target: prev.target === source ? (source === 'GCP' ? 'AWS' : 'GCP') : prev.target,
        })),
      setTarget: (target: EnvId) => patch({ target }),
      connect: (env: EnvId) => patch({ connecting: env }),
      setField: (field: 'replicas' | 'resources', value: string) => patch({ [field]: { value, confirmed: false } }),
      confirmField: (field: 'replicas' | 'resources') =>
        setState((prev) => ({ ...prev, [field]: { ...prev[field], confirmed: !prev[field].confirmed } })),
      toggleAutoplay: () => setState((prev) => ({ ...prev, autoplay: !prev.autoplay })),
      newMigration: () => go('connect', { ...initialState, connected: state.connected }),
      confirmSpec: () => go('precheck', { precheckStep: 0, autoplay: true }),
      startMigration: () =>
        go('running', {
          stage: 'provisioning',
          traffic: 0,
          guardrailCleared: false,
          merge: 'open',
          metricsAvailable: true,
          autoplay: true,
        }),
      resumeMigration: () => go('running', { stage: 'shifting', guardrailCleared: true, autoplay: true }),
      mergeFix: () => patch({ merge: 'detecting' }),
      rollback: (cause: RollbackCause = 'manual') =>
        go(cause === 'manual' ? 'rollingBack' : 'autoRollback', { rollbackCause: cause, rollbackStep: 0, autoplay: true }),
      /** 대기 시간을 기다리지 않고 바로 정리로 넘어간다. 되돌릴 수 없다. */
      reclaimResources: () => go('cleanup', { cleanupStep: 0, autoplay: true }),
      attest: (key: string) => setState((prev) => ({ ...prev, attested: { ...prev.attested, [key]: true } })),
      acknowledge: (id: string) => setState((prev) => ({ ...prev, acknowledged: { ...prev.acknowledged, [id]: true } })),
    }),
    [screen, state, go, jump, patch],
  );
}

export type MigrationFlow = ReturnType<typeof useMigrationFlow>;
