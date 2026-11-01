import type { ComponentType } from 'react';
import type { ScreenId } from '../features/migration/flow';
import { CancelledScreen, DoneScreen, FailedScreen, LogScreen, RolledBackScreen } from '../features/migration/screens/finish';
import { AgentScreen, DashboardScreen, EnvironmentsScreen, LoginScreen, SettingsScreen } from '../features/migration/screens/overview';
import { CleanupScreen, FixScreen, PausedScreen, RollbackWindowScreen, RollingBackScreen, RunningScreen } from '../features/migration/screens/run';
import { GuardrailsScreen, SecurityScreen, ThreatsScreen } from '../features/migration/screens/security';
import {
  ApprovedScreen,
  ApproveScreen,
  BlockedScreen,
  ConnectFailedScreen,
  ConnectScreen,
  CostScreen,
  PrecheckScreen,
  ReadScreen,
  RejectedScreen,
  SpecScreen,
  StaleScreen,
} from '../features/migration/screens/setup';
import type { ScreenProps } from '../features/migration/screens/shared';
import { useMigrationFlow } from '../features/migration/useMigrationFlow';
import { PrototypeMenu } from './PrototypeMenu';

const SCREEN_VIEWS: Record<ScreenId, ComponentType<ScreenProps>> = {
  login: LoginScreen,
  dashboard: DashboardScreen,
  environments: EnvironmentsScreen,
  settings: SettingsScreen,
  connect: ConnectScreen,
  connectFailed: ConnectFailedScreen,
  read: ReadScreen,
  spec: SpecScreen,
  precheck: PrecheckScreen,
  blocked: BlockedScreen,
  approve: ApproveScreen,
  cost: CostScreen,
  rejected: RejectedScreen,
  stale: StaleScreen,
  approved: ApprovedScreen,
  envBusy: ApprovedScreen,
  running: RunningScreen,
  noMetrics: RunningScreen,
  paused: PausedScreen,
  fix: FixScreen,
  window: RollbackWindowScreen,
  cleanup: CleanupScreen,
  done: DoneScreen,
  rollingBack: RollingBackScreen,
  autoRollback: RollingBackScreen,
  rolledBack: RolledBackScreen,
  failed: FailedScreen,
  cancelled: CancelledScreen,
  security: SecurityScreen,
  threats: ThreatsScreen,
  guardrails: GuardrailsScreen,
  log: LogScreen,
  agent: AgentScreen,
};

export function App() {
  const flow = useMigrationFlow();
  const Screen = SCREEN_VIEWS[flow.screen];
  return (
    <>
      <Screen flow={flow} />
      <PrototypeMenu flow={flow} />
    </>
  );
}
