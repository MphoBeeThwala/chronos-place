import { createRefreshCoordinator } from './session-refresh';

/** One refresh coordinator per tab, shared by Apollo and the capture upload. */
export const refreshSession = createRefreshCoordinator();
