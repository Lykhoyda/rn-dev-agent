import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { View, Text, Pressable, RefreshControl } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useThemeColors } from '../hooks/useThemeColors';
import type { ThemeColors } from '../hooks/useThemeColors';

type LogLevel = 'all' | 'log' | 'info' | 'warn' | 'error';

interface LogEntry {
  id: string;
  level: string;
  text: string;
  timestamp: string;
}

const LEVELS: LogLevel[] = ['all', 'log', 'info', 'warn', 'error'];

const LEVEL_COLORS: Record<string, { bg: string; text: string }> = {
  error: { bg: 'bg-red-100', text: 'text-red-700' },
  warn: { bg: 'bg-amber-100', text: 'text-amber-700' },
  info: { bg: 'bg-blue-100', text: 'text-blue-700' },
  log: { bg: 'bg-gray-100', text: 'text-gray-600' },
  debug: { bg: 'bg-gray-100', text: 'text-gray-500' },
};

function generateDiagnosticLogs(): void {
  console.log('[Diagnostics] Screen mounted — generating sample log entries');
  console.info('[Diagnostics] App version: 1.0.0, RN: 0.81.5, Expo: 54');
  console.warn('[Diagnostics] Memory usage approaching threshold (simulated)');
  console.error('[Diagnostics] Failed to connect to analytics service (simulated)');
  console.log('[Diagnostics] Redux store has 4 slices, 1 Zustand store registered');
  console.info('[Diagnostics] Network: online, Metro: connected');
  console.warn('[Diagnostics] Bundle size exceeds recommended 5MB limit (simulated)');
  console.log('[Diagnostics] Navigation: 4 tabs, 4 stack navigators, 5 modals');
}

function LevelPill({ level, active, colors, onPress }: {
  level: LogLevel;
  active: boolean;
  colors: ThemeColors;
  onPress: () => void;
}) {
  return (
    <Pressable
      testID={`diag-filter-${level}`}
      className={`rounded-full px-4 py-1.5 ${active ? 'bg-blue-500' : colors.card}`}
      onPress={onPress}
    >
      <Text className={active ? 'font-semibold text-white' : colors.text}>
        {level === 'all' ? 'All' : level.charAt(0).toUpperCase() + level.slice(1)}
      </Text>
    </Pressable>
  );
}

function LogRow({ item }: { item: LogEntry }) {
  const style = LEVEL_COLORS[item.level] ?? LEVEL_COLORS.log;
  const time = item.timestamp.split('T')[1]?.slice(0, 12) ?? '';
  return (
    <View testID={`diag-log-${item.id}`} className="mb-1 flex-row items-start px-4 py-2">
      <View className={`mr-2 rounded px-1.5 py-0.5 ${style.bg}`}>
        <Text className={`text-xs font-bold ${style.text}`}>{item.level.toUpperCase()}</Text>
      </View>
      <View className="flex-1">
        <Text className="text-sm text-gray-900 dark:text-white" numberOfLines={3}>{item.text}</Text>
        <Text className="mt-0.5 text-xs text-gray-400">{time}</Text>
      </View>
    </View>
  );
}

export default function DiagnosticsScreen() {
  const colors = useThemeColors();
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState<LogLevel>('all');
  const [refreshing, setRefreshing] = useState(false);
  const mountedRef = useRef(true);

  const collectLogs = useCallback(() => {
    generateDiagnosticLogs();

    const now = new Date();
    const sampleEntries: LogEntry[] = [
      { id: '1', level: 'log', text: '[Diagnostics] Screen mounted — generating sample log entries', timestamp: new Date(now.getTime() - 7000).toISOString() },
      { id: '2', level: 'info', text: '[Diagnostics] App version: 1.0.0, RN: 0.81.5, Expo: 54', timestamp: new Date(now.getTime() - 6000).toISOString() },
      { id: '3', level: 'warn', text: '[Diagnostics] Memory usage approaching threshold (simulated)', timestamp: new Date(now.getTime() - 5000).toISOString() },
      { id: '4', level: 'error', text: '[Diagnostics] Failed to connect to analytics service (simulated)', timestamp: new Date(now.getTime() - 4000).toISOString() },
      { id: '5', level: 'log', text: '[Diagnostics] Redux store has 4 slices, 1 Zustand store registered', timestamp: new Date(now.getTime() - 3000).toISOString() },
      { id: '6', level: 'info', text: '[Diagnostics] Network: online, Metro: connected', timestamp: new Date(now.getTime() - 2000).toISOString() },
      { id: '7', level: 'warn', text: '[Diagnostics] Bundle size exceeds recommended 5MB limit (simulated)', timestamp: new Date(now.getTime() - 1000).toISOString() },
      { id: '8', level: 'log', text: '[Diagnostics] Navigation: 4 tabs, 4 stack navigators, 5 modals', timestamp: now.toISOString() },
    ];
    setEntries(sampleEntries);
  }, []);

  useEffect(() => {
    collectLogs();
    return () => { mountedRef.current = false; };
  }, [collectLogs]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    collectLogs();
    setTimeout(() => {
      if (mountedRef.current) setRefreshing(false);
    }, 500);
  }, [collectLogs]);

  const filtered = useMemo(
    () => filter === 'all' ? entries : entries.filter(e => e.level === filter),
    [filter, entries],
  );

  const renderItem = useCallback(({ item }: { item: LogEntry }) => (
    <LogRow item={item} />
  ), []);

  return (
    <View testID="diag-screen" className={`flex-1 ${colors.bg}`}>
      <View className="px-4 pt-4 pb-2">
        <Text testID="diag-title" className={`text-xl font-bold ${colors.text}`}>Diagnostics</Text>
        <Text testID="diag-subtitle" className={`mt-1 ${colors.muted}`}>
          {filtered.length} log {filtered.length === 1 ? 'entry' : 'entries'}
        </Text>
        <View testID="diag-filters" className="mt-3 flex-row flex-wrap gap-2">
          {LEVELS.map(l => (
            <LevelPill key={l} level={l} active={filter === l} colors={colors} onPress={() => setFilter(l)} />
          ))}
        </View>
      </View>
      <View className="flex-1">
      <FlashList
        testID="diag-log-list"
        data={filtered}
        renderItem={renderItem}
        keyExtractor={item => item.id}
        estimatedItemSize={60}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
        ListEmptyComponent={
          <View testID="diag-empty" className="items-center py-12">
            <Text className={colors.muted}>No logs matching filter</Text>
          </View>
        }
      />
      </View>
    </View>
  );
}
