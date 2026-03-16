import React, { useEffect, useRef, useState } from 'react';
import { LayoutAnimation, Platform, Pressable, StatusBar, Text, UIManager, View } from 'react-native';
import { useDispatch } from 'react-redux';
import type { AppDispatch } from '../store';
import { setOnline } from '../store/slices/networkSlice';
import { useNetworkStatus } from '../hooks/useNetworkStatus';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const STATUS_BAR_HEIGHT = Platform.OS === 'ios' ? 59 : (StatusBar.currentHeight ?? 24);

export default function OfflineBanner() {
  const dispatch = useDispatch<AppDispatch>();
  const { isOffline } = useNetworkStatus();
  const [showOnlineToast, setShowOnlineToast] = useState(false);
  const wasOfflineRef = useRef(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }

    if (wasOfflineRef.current !== isOffline) {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    }

    if (wasOfflineRef.current && !isOffline) {
      setShowOnlineToast(true);
      toastTimerRef.current = setTimeout(() => {
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        setShowOnlineToast(false);
        toastTimerRef.current = null;
      }, 2000);
    }

    wasOfflineRef.current = isOffline;

    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, [isOffline]);

  const handleRetry = () => {
    (globalThis as Record<string, unknown>).__OFFLINE__ = false;
    dispatch(setOnline());
  };

  if (isOffline) {
    return (
      <View
        testID="offline-banner"
        className="flex-row items-center justify-between bg-red-500 px-4 pb-3"
        style={{ paddingTop: STATUS_BAR_HEIGHT }}
        accessibilityRole="alert"
      >
        <Text className="font-semibold text-white">No Connection</Text>
        <Pressable
          testID="offline-retry-btn"
          className="rounded bg-white/20 px-3 py-1"
          onPress={handleRetry}
          accessibilityLabel="Retry connection"
        >
          <Text className="font-medium text-white">Retry</Text>
        </Pressable>
      </View>
    );
  }

  if (showOnlineToast) {
    return (
      <View
        testID="online-toast"
        className="items-center bg-green-500 px-4 pb-3"
        style={{ paddingTop: STATUS_BAR_HEIGHT }}
      >
        <Text className="font-semibold text-white">Back Online</Text>
      </View>
    );
  }

  return null;
}
