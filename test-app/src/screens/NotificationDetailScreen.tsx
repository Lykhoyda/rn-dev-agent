import React, { useEffect } from 'react';
import { View, Text, Pressable } from 'react-native';
import { useSelector, useDispatch } from 'react-redux';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootState } from '../store';
import type { NotificationsStackParams } from '../navigation/types';
import { markRead } from '../store/slices/notificationsSlice';

const API_BASE = 'https://api.testapp.local';

type Props = NativeStackScreenProps<NotificationsStackParams, 'NotificationDetail'>;

export default function NotificationDetailScreen({ route, navigation }: Props) {
  const { id } = route.params;
  const dispatch = useDispatch();
  const item = useSelector((state: RootState) =>
    state.notifications.items.find((i) => i.id === id),
  );

  useEffect(() => {
    console.log(`[NotificationDetail] viewing notification ${id}`);
  }, [id]);

  if (!item) {
    return (
      <View testID="notif-detail-empty" className="flex-1 items-center justify-center bg-white">
        <Text className="text-lg text-gray-500">Notification not found</Text>
        <Pressable
          testID="notif-detail-back-btn"
          className="mt-4 rounded-lg bg-blue-500 px-4 py-3"
          onPress={() => navigation.goBack()}
        >
          <Text className="text-center font-semibold text-white">Go Back</Text>
        </Pressable>
      </View>
    );
  }

  const handleMarkRead = () => {
    console.log(`[NotificationDetail] marking ${id} as read`);
    dispatch(markRead(id));
    fetch(`${API_BASE}/api/notifications/read`, { method: 'POST' }).catch(() => {});
  };

  return (
    <View testID="notif-detail-container" className="flex-1 bg-white px-4 pt-6">
      <Text testID="notif-detail-title" className="text-2xl font-bold">
        {item.title}
      </Text>

      <Text testID="notif-detail-body" className="mt-4 text-base text-gray-600">
        This is the full detail view for notification #{id}. In a real app this
        would contain the complete notification content, timestamps, and related
        actions.
      </Text>

      <View testID="notif-detail-status" className="mt-4 flex-row items-center">
        <View
          className={`h-3 w-3 rounded-full ${item.read ? 'bg-gray-300' : 'bg-blue-500'}`}
        />
        <Text className="ml-2 text-sm text-gray-500">
          {item.read ? 'Read' : 'Unread'}
        </Text>
      </View>

      {!item.read && (
        <Pressable
          testID="notif-detail-mark-read-btn"
          className="mt-6 rounded-lg bg-green-500 px-4 py-3"
          onPress={handleMarkRead}
        >
          <Text className="text-center font-semibold text-white">Mark as Read</Text>
        </Pressable>
      )}

      <Pressable
        testID="notif-detail-back-btn"
        className="mt-3 rounded-lg bg-gray-200 px-4 py-3"
        onPress={() => navigation.goBack()}
      >
        <Text className="text-center font-semibold text-gray-700">Back to List</Text>
      </Pressable>
    </View>
  );
}
