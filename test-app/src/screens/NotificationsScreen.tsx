import React, { useEffect } from 'react';
import { View, Text, Pressable, FlatList } from 'react-native';
import { useSelector, useDispatch } from 'react-redux';
import type { RootState } from '../store';
import { markAllRead } from '../store/slices/notificationsSlice';
import type { NotificationItem } from '../store/slices/notificationsSlice';

const API_BASE = 'https://api.testapp.local';

export default function NotificationsScreen() {
  const dispatch = useDispatch();
  const { items, unreadCount } = useSelector((state: RootState) => state.notifications);

  useEffect(() => {
    console.log('notifications loaded');
    console.warn('stale cache');
    console.error('notification parse failed');
  }, []);

  const handleMarkRead = async () => {
    await fetch(`${API_BASE}/api/notifications/read`, { method: 'POST' });
    dispatch(markAllRead());
  };

  const renderItem = ({ item, index }: { item: NotificationItem; index: number }) => (
    <View
      testID={`notif-item-${index}`}
      className={`mb-2 rounded-lg p-4 ${item.read ? 'bg-gray-50' : 'bg-blue-50'}`}
    >
      <Text className={item.read ? 'text-gray-500' : 'font-semibold'}>{item.title}</Text>
    </View>
  );

  return (
    <View className="flex-1 bg-white px-4 pt-4">
      <Text className="text-xl font-bold">Notifications ({unreadCount} unread)</Text>

      <FlatList
        className="mt-4"
        data={items}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
      />

      <Pressable
        testID="notif-mark-read-btn"
        className="mt-4 rounded-lg bg-green-500 px-4 py-3"
        onPress={handleMarkRead}
      >
        <Text className="text-center font-semibold text-white">Mark All Read</Text>
      </Pressable>
    </View>
  );
}
