import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { useSelector, useDispatch } from 'react-redux';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { CompositeScreenProps } from '@react-navigation/native';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { RootState } from '../store';
import type { ProfileStackParams, TabParams } from '../navigation/types';
import { updateName } from '../store/slices/userSlice';

type Props = CompositeScreenProps<
  NativeStackScreenProps<ProfileStackParams, 'ProfileMain'>,
  BottomTabScreenProps<TabParams>
>;

export default function ProfileScreen({ navigation }: Props) {
  const user = useSelector((state: RootState) => state.user);
  const dispatch = useDispatch();

  const handleUpdateName = () => {
    const newName = user.name === 'Test User' ? 'Updated User' : 'Test User';
    dispatch(updateName(newName));
  };

  return (
    <View className="flex-1 bg-white px-4 pt-4">
      <View testID="profile-avatar" className="mb-4 h-20 w-20 rounded-full bg-gray-200" />
      <Text testID="profile-name" className="text-xl font-bold">{user.name}</Text>
      <Text testID="profile-email" className="mt-1 text-gray-500">{user.email}</Text>

      <Pressable
        testID="profile-update-btn"
        className="mt-6 rounded-lg bg-blue-500 px-4 py-3"
        onPress={handleUpdateName}
      >
        <Text className="text-center font-semibold text-white">Update Name</Text>
      </Pressable>

      <Pressable
        testID="profile-settings-btn"
        className="mt-3 rounded-lg bg-gray-200 px-4 py-3"
        onPress={() => navigation.navigate('Settings')}
      >
        <Text className="text-center font-semibold">Settings</Text>
      </Pressable>
    </View>
  );
}
