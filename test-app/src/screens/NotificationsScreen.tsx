import React, { useEffect } from 'react';
import { View, Text, Pressable, FlatList } from 'react-native';
import { useSelector, useDispatch } from 'react-redux';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootState } from '../store';
import { markAllRead, clearAll, selectUnreadCount } from '../store/slices/notificationsSlice';
import type { NotificationItem } from '../store/slices/notificationsSlice';
import type { NotificationsStackParams } from '../navigation/types';

const API_BASE = 'https://api.testapp.local';

type Props = NativeStackScreenProps<NotificationsStackParams, 'NotificationsMain'>;

export default function NotificationsScreen({ navigation }: Props) {
  const dispatch = useDispatch();
  const items = useSelector((state: RootState) => state.notifications.items);
  const unreadCount = useSelector(selectUnreadCount);

  useEffect(() => {
    console.log('notifications loaded');
    console.warn('stale cache');
    console.error('notification parse failed');
  }, []);

  const handleMarkAllRead = () => {
    dispatch(markAllRead());
    fetch(`${API_BASE}/api/notifications/read`, { method: 'POST' }).catch(() => {});
  };

  const handleClearAll = () => {
    console.log('[Notifications] clearing all notifications');
    dispatch(clearAll());
  };

  const renderItem = ({ item, index }: { item: NotificationItem; index: number }) => (
    <Pressable
      testID={`notif-item-${index}`}
      className={`mb-2 rounded-lg p-4 ${item.read ? 'bg-gray-50' : 'bg-blue-50'}`}
      onPress={() => navigation.navigate('NotificationDetail', { id: item.id })}
    >
      <Text className={item.read ? 'text-gray-500' : 'font-semibold'}>{item.title}</Text>
      <Text className="mt-1 text-xs text-gray-400">Tap to view details</Text>
    </Pressable>
  );

  return (
    <View testID="notif-screen" className="flex-1 bg-white px-4 pt-4">
      <Text testID="notif-header" className="text-xl font-bold">
        Notifications ({unreadCount} unread)
      </Text>

      {items.length === 0 ? (
        <View testID="notif-empty" className="flex-1 items-center justify-center">
          <Text className="text-lg text-gray-400">No notifications</Text>
        </View>
      ) : (
        <FlatList
          testID="notif-list"
          className="mt-4"
          data={items}
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
