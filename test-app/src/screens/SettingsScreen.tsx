import React from 'react';
import { View, Text, Switch, Pressable } from 'react-native';
import { useSelector, useDispatch } from 'react-redux';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootState } from '../store';
import type { ProfileStackParams } from '../navigation/types';
import { toggleTheme, setLanguage } from '../store/slices/settingsSlice';

type Props = NativeStackScreenProps<ProfileStackParams, 'Settings'>;

export default function SettingsScreen({ navigation }: Props) {
  const dispatch = useDispatch();
  const settings = useSelector((state: RootState) => state.settings);

  return (
    <View className="flex-1 bg-white px-4 pt-4">
      <Text className="text-xl font-bold">Settings</Text>

      <View className="mt-6 flex-row items-center justify-between">
        <Text className="text-base">Dark Theme</Text>
        <Switch
          testID="settings-theme-toggle"
          value={settings.theme === 'dark'}
          onValueChange={() => dispatch(toggleTheme())}
        />
      </View>

      <View className="mt-4 flex-row items-center justify-between">
        <Text className="text-base">Language (DE)</Text>
        <Switch
          testID="settings-language-toggle"
          value={settings.language === 'de'}
          onValueChange={(value) => dispatch(setLanguage(value ? 'de' : 'en'))}
        />
      </View>

      <Pressable
        testID="settings-reload-btn"
        className="mt-6 rounded-lg bg-gray-200 px-4 py-3"
        onPress={() => navigation.navigate('ReloadTest')}
      >
        <Text className="text-center font-semibold">Reload Test</Text>
      </Pressable>
    </View>
  );
}
