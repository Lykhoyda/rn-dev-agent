import React from 'react';
import { View, Text } from 'react-native';

export default function HomeScreen() {
  return (
    <View testID="home-welcome" className="flex-1 items-center justify-center bg-white">
      <Text className="text-xl font-bold">Home</Text>
    </View>
  );
}
