import React from 'react';
import { View, Text } from 'react-native';

export default function NotificationsScreen() {
  return (
    <View testID="notif-screen" className="flex-1 items-center justify-center bg-white">
      <Text className="text-xl font-bold">Notifications</Text>
    </View>
  );
}
