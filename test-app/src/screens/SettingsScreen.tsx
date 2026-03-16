import React from 'react';
import { View, Text, Switch, Pressable, ScrollView } from 'react-native';
import { useSelector, useDispatch } from 'react-redux';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootState } from '../store';
import type { ProfileStackParams } from '../navigation/types';
import { toggleTheme, setLanguage } from '../store/slices/settingsSlice';
import { selectLastSynced } from '../store/slices/settingsSlice';
import { formatRelativeTime } from '../store/slices/feedSlice';
import { useSyncContext } from '../context/SyncContext';
import { useThemeColors } from '../hooks/useThemeColors';
import { usePreferencesStore } from '../store/usePreferencesStore';
import type { FontSize } from '../store/usePreferencesStore';

type Props = NativeStackScreenProps<ProfileStackParams, 'Settings'>;

export default function SettingsScreen({ navigation }: Props) {
  const dispatch = useDispatch();
  const settings = useSelector((state: RootState) => state.settings);
  const lastSynced = useSelector(selectLastSynced);
  const { syncNow, isSyncing } = useSyncContext();
  const colors = useThemeColors();
  const fontSize = usePreferencesStore((s) => s.fontSize);
  const compactMode = usePreferencesStore((s) => s.compactMode);
  const accentColor = usePreferencesStore((s) => s.accentColor);
  const setFontSize = usePreferencesStore((s) => s.setFontSize);
  const toggleCompactMode = usePreferencesStore((s) => s.toggleCompactMode);
  const setAccentColor = usePreferencesStore((s) => s.setAccentColor);

  const FONT_SIZES: FontSize[] = ['small', 'medium', 'large'];
  const ACCENT_COLORS = [
    { name: 'blue', value: '#3b82f6' },
    { name: 'green', value: '#22c55e' },
    { name: 'purple', value: '#a855f7' },
    { name: 'red', value: '#ef4444' },
  ];

  return (
    <ScrollView testID="settings-screen" className={`flex-1 ${colors.bg} px-4 pt-4`}>
      <Text className={`text-xl font-bold ${colors.text}`}>Settings</Text>

      <View className="mt-6 flex-row items-center justify-between">
        <Text className={`text-base ${colors.text}`}>Theme</Text>
        <Pressable
          testID="settings-theme-toggle"
          accessibilityRole="switch"
          accessibilityState={{ checked: settings.theme === 'dark' }}
          className={`rounded-lg px-4 py-2 ${colors.card}`}
          onPress={() => dispatch(toggleTheme())}
        >
          <Text testID="settings-theme-label" className={`font-semibold ${colors.text}`}>
            {settings.theme === 'dark' ? 'Dark' : 'Light'}
          </Text>
        </Pressable>
      </View>

      <View className="mt-4 flex-row items-center justify-between">
        <Text className={`text-base ${colors.text}`}>Language (DE)</Text>
        <Switch
          testID="settings-language-toggle"
          value={settings.language === 'de'}
          onValueChange={(value) => { dispatch(setLanguage(value ? 'de' : 'en')); }}
        />
      </View>

      <View className="mt-6 flex-row items-center justify-between">
        <Text className={`text-base ${colors.text}`}>Last synced</Text>
        <Text testID="sync-status-label" className={`text-sm ${colors.muted}`}>
          {lastSynced ? formatRelativeTime(lastSynced) : 'Never'}
        </Text>
      </View>

      <Pressable
        testID="sync-now-btn"
        className={`mt-3 rounded-lg px-4 py-3 ${isSyncing ? 'bg-gray-400' : 'bg-indigo-500'}`}
        onPress={syncNow}
        disabled={isSyncing}
      >
        <Text className="text-center font-semibold text-white">
          {isSyncing ? 'Syncing...' : 'Sync Now'}
        </Text>
      </Pressable>

      {/* Appearance (Zustand) */}
      <Text className={`mt-8 mb-3 text-lg font-bold ${colors.text}`}>Appearance</Text>

      <Text className={`mb-2 text-sm font-medium ${colors.muted}`}>Font Size</Text>
      <View className="mb-4 flex-row gap-2">
        {FONT_SIZES.map((size) => (
          <Pressable
            key={size}
            testID={`pref-font-size-${size}`}
            onPress={() => setFontSize(size)}
            className={`rounded-full px-4 py-2 ${fontSize === size ? 'bg-blue-500' : colors.card}`}
          >
            <Text className={`text-sm font-medium ${fontSize === size ? 'text-white' : colors.text}`}>
              {size.charAt(0).toUpperCase() + size.slice(1)}
            </Text>
          </Pressable>
        ))}
      </View>

      <View className="mb-4 flex-row items-center justify-between">
        <Text className={`text-base ${colors.text}`}>Compact Mode</Text>
        <Switch
          testID="pref-compact-toggle"
          value={compactMode}
          onValueChange={toggleCompactMode}
        />
      </View>

      <Text className={`mb-2 text-sm font-medium ${colors.muted}`}>Accent Color</Text>
      <View className="mb-4 flex-row gap-3">
        {ACCENT_COLORS.map((c) => (
          <Pressable
            key={c.name}
            testID={`pref-accent-${c.name}`}
            onPress={() => setAccentColor(c.value)}
            className="items-center"
          >
            <View
              style={{ backgroundColor: c.value, width: 36, height: 36, borderRadius: 18, borderWidth: accentColor === c.value ? 3 : 0, borderColor: '#000' }}
            />
            <Text className={`mt-1 text-xs ${colors.muted}`}>{c.name}</Text>
          </Pressable>
        ))}
      </View>

      <Pressable
        testID="settings-reload-btn"
        className={`mt-6 rounded-lg px-4 py-3 ${colors.card}`}
        onPress={() => navigation.navigate('ReloadTest')}
      >
        <Text className={`text-center font-semibold ${colors.text}`}>Reload Test</Text>
      </Pressable>

      <View className="h-10" />
    </ScrollView>
  );
}
