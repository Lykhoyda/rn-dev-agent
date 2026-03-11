import React from 'react';
import { View, Text } from 'react-native';

export default function ProfileScreen() {
  return (
    <View testID="profile-screen" className="flex-1 items-center justify-center bg-white">
      <Text className="text-xl font-bold">Profile</Text>
    </View>
  );
}
