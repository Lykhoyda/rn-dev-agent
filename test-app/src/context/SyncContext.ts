import { createContext, useContext } from 'react';

export interface SyncContextValue {
  syncNow: () => void;
  isSyncing: boolean;
}

const SyncContext = createContext<SyncContextValue>({
  syncNow: () => {},
  isSyncing: false,
});

export function useSyncContext(): SyncContextValue {
  return useContext(SyncContext);
}

export default SyncContext;
