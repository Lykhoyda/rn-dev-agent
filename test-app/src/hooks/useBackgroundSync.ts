import { useCallback, useEffect, useRef, useState } from 'react';
import { useDispatch } from 'react-redux';
import type { AppDispatch } from '../store';
import { setLastSynced } from '../store/slices/settingsSlice';
import type { SyncContextValue } from '../context/SyncContext';

const SYNC_INTERVAL = 30_000;
const API_BASE = 'https://api.testapp.local';

export function useBackgroundSync(): SyncContextValue {
  const dispatch = useDispatch<AppDispatch>();
  const [isSyncing, setIsSyncing] = useState(false);
  const isSyncingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => () => { mountedRef.current = false; }, []);

  const doSync = useCallback(async () => {
    if (isSyncingRef.current) return;
    isSyncingRef.current = true;
    if (mountedRef.current) setIsSyncing(true);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      await fetch(`${API_BASE}/api/sync`, { signal: controller.signal });
    } catch {
      // Expected: AbortError from non-existent API
    } finally {
      clearTimeout(timeout);
      dispatch(setLastSynced(Date.now()));
      isSyncingRef.current = false;
      if (mountedRef.current) setIsSyncing(false);
    }
  }, [dispatch]);

  useEffect(() => {
    void doSync();
    const id = setInterval(() => { void doSync(); }, SYNC_INTERVAL);
    return () => clearInterval(id);
  }, [doSync]);

  return { syncNow: doSync, isSyncing };
}
