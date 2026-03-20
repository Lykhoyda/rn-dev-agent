import React, { useCallback, useEffect, useRef } from 'react';
import { View, Text, Pressable, FlatList } from 'react-native';
import { useSelector, shallowEqual, useDispatch, useStore } from 'react-redux';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootState } from '../store';
import {
  markAllRead,
  clearAll,
  selectUnreadCount,
  selectVisibleNotifications,
  selectSnoozedCount,
  unsnoozeNotification,
} from '../store/slices/notificationsSlice';
import type { NotificationItem } from '../store/slices/notificationsSlice';
import type { NotificationsStackParams } from '../navigation/types';
import { useThemeColors } from '../hooks/useThemeColors';

const API_BASE = 'https://api.testapp.local';

type Props = NativeStackScreenProps<NotificationsStackParams, 'NotificationsMain'>;

export default function NotificationsScreen({ navigation }: Props) {
  const dispatch = useDispatch();
  const store = useStore<RootState>();
  const colors = useThemeColors();
  const visibleItems = useSelector(selectVisibleNotifications, shallowEqual);
  const unreadCount = useSelector(selectUnreadCount);
  const snoozedCount = useSelector(selectSnoozedCount);
  const allItems = useSelector((state: RootState) => state.notifications.items);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (__DEV__) {
      console.log('notifications loaded');
      console.warn('stale cache');
      console.warn('notification parse failed');
    }
  }, []);

  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    const now = Date.now();
    const snoozed = allItems.filter((i) => i.snoozedUntil !== null && i.snoozedUntil > now);

    if (snoozed.length === 0) return;

    const nearest = Math.min(...snoozed.map((i) => i.snoozedUntil!));
    const delay = Math.max(nearest - now, 100);

    timerRef.current = setTimeout(() => {
      const currentItems = store.getState().notifications.items;
      const expired = currentItems.filter(
        (i) => i.snoozedUntil !== null && i.snoozedUntil <= Date.now(),
      );
      expired.forEach((i) => {
        if (__DEV__) {
          console.log(`[Notifications] auto-unsnoozed notification ${i.id}`);
        }
        dispatch(unsnoozeNotification(i.id));
      });
    }, delay);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [allItems, dispatch, store]);

  const handleMarkAllRead = () => {
    dispatch(markAllRead());
    fetch(`${API_BASE}/api/notifications/read`, { method: 'POST' }).catch(() => {});
  };

  const handleClearAll = () => {
    if (__DEV__) {
      console.log('[Notifications] clearing all notifications');
    }
    dispatch(clearAll());
  };

  const renderItem = useCallback(({ item }: { item: NotificationItem }) => (
    <Pressable
      testID={`notif-item-${item.id}`}
      className={`mb-2 rounded-lg p-4 ${item.read ? colors.card : 'bg-blue-50'}`}
      onPress={() => navigation.navigate('NotificationDetail', { id: item.id })}
    >
      <Text className={item.read ? colors.muted : `font-semibold ${colors.text}`}>{item.title}</Text>
      <Text className={`mt-1 text-xs ${colors.muted}`}>Tap to view details</Text>
    </Pressable>
  ), [colors, navigation]);

  return (
    <View testID="notif-screen" className={`flex-1 ${colors.bg} px-4 pt-4`}>
      <Text testID="notif-header" className={`text-xl font-bold ${colors.text}`}>
        Notifications ({unreadCount} unread{snoozedCount > 0 ? `, ${snoozedCount} snoozed` : ''})
      </Text>
      {snoozedCount > 0 && (
        <Text testID="notif-snoozed-badge" className="mt-1 text-sm text-amber-600">
          {snoozedCount} notification{snoozedCount > 1 ? 's' : ''} snoozed
        </Text>
      )}

      {visibleItems.length === 0 ? (
        <View testID="notif-empty" className="flex-1 items-center justify-center">
          <Text className={`text-lg ${colors.muted}`}>No notifications</Text>
        </View>
      ) : (
        <FlatList
          testID="notif-list"
          className="mt-4"
          data={visibleItems}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
        />
      )}

      <View className="flex-row gap-2 pb-4 pt-2">
        <Pressable
          testID="notif-mark-read-btn"
          className="flex-1 rounded-lg bg-green-500 px-4 py-3"
          onPress={handleMarkAllRead}
        >
          <Text className="text-center font-semibold text-white">Mark All Read</Text>
        </Pressable>

        <Pressable
          testID="notif-clear-all-btn"
          className="flex-1 rounded-lg bg-red-500 px-4 py-3"
          onPress={handleClearAll}
        >
          <Text className="text-center font-semibold text-white">Clear All</Text>
        </Pressable>
      </View>
    </View>
  );
}
