import { useEffect, useRef } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import type { AppDispatch } from '../store';
import { setOffline, setOnline, selectIsOffline } from '../store/slices/networkSlice';

const POLL_INTERVAL = 2000;

export function useNetworkStatus() {
  const dispatch = useDispatch<AppDispatch>();
  const isOffline = useSelector(selectIsOffline);
  const prevRef = useRef(false);

  useEffect(() => {
    const check = () => {
      const flag = !!(globalThis as Record<string, unknown>).__OFFLINE__;
      if (flag !== prevRef.current) {
        prevRef.current = flag;
        dispatch(flag ? setOffline() : setOnline());
      }
    };
    check();
    const id = setInterval(check, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [dispatch]);

  return { isOffline };
}
