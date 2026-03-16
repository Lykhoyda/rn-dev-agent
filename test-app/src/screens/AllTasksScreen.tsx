import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { View, Text, TextInput } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useThemeColors } from '../hooks/useThemeColors';
import type { TaskPriority } from '../store/slices/tasksSlice';
import { PRIORITY_STYLES } from '../constants/taskStyles';

interface GeneratedTask {
  id: string;
  title: string;
  done: boolean;
  priority: TaskPriority;
}

const PRIORITIES: TaskPriority[] = ['high', 'medium', 'low'];
const TASK_TITLES = [
  'Review PR', 'Fix bug', 'Write tests', 'Update docs', 'Deploy release',
  'Code review', 'Design meeting', 'Sprint planning', 'Refactor module', 'Add feature',
  'Setup CI', 'Migrate DB', 'Optimize query', 'Create endpoint', 'Debug crash',
  'Write spec', 'Pair program', 'Monitor alerts', 'Update deps', 'Clean cache',
];

function generateTasks(count: number): GeneratedTask[] {
  return Array.from({ length: count }, (_, i) => ({
    id: String(i + 1),
    title: `${TASK_TITLES[i % TASK_TITLES.length]} #${i + 1}`,
    done: i % 5 === 0,
    priority: PRIORITIES[i % 3],
  }));
}

const ALL_TASKS = generateTasks(500);

export default function AllTasksScreen() {
  const colors = useThemeColors();
  const [searchText, setSearchText] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(searchText), 200);
    return () => clearTimeout(timer);
  }, [searchText]);

  const filteredTasks = useMemo(() => {
    if (!debouncedQuery) return ALL_TASKS;
    const lower = debouncedQuery.toLowerCase();
    return ALL_TASKS.filter(t => t.title.toLowerCase().includes(lower));
  }, [debouncedQuery]);

  const renderItem = useCallback(({ item }: { item: GeneratedTask }) => {
    const pStyle = PRIORITY_STYLES[item.priority];
    return (
      <View testID={`all-task-${item.id}`} className={`mx-4 mb-2 flex-row items-center rounded-lg p-3 ${colors.card}`}>
        <View className={`mr-3 rounded-full px-2 py-0.5 ${pStyle.bg}`}>
          <Text className={`text-xs font-medium ${pStyle.text}`}>{pStyle.label}</Text>
        </View>
        <Text className={`flex-1 ${item.done ? 'line-through' : ''} ${colors.text}`} numberOfLines={1}>
          {item.title}
        </Text>
      </View>
    );
  }, [colors]);

  return (
    <View testID="all-tasks-screen" className={`flex-1 ${colors.bg} pt-4`}>
      <View className="px-4 mb-2">
        <TextInput
          testID="all-tasks-search"
          className={`rounded-lg border ${colors.border} px-3 py-2 text-base ${colors.text} ${colors.card}`}
          placeholder="Search 500 tasks..."
          placeholderTextColor={colors.placeholderColor}
          value={searchText}
          onChangeText={setSearchText}
          autoCorrect={false}
          autoCapitalize="none"
        />
        <Text testID="all-tasks-count" className={`mt-1 text-xs ${colors.muted}`}>
          Showing {filteredTasks.length} of {ALL_TASKS.length} tasks
        </Text>
      </View>

      <FlashList
        testID="all-tasks-list"
        data={filteredTasks}
        renderItem={renderItem}
        estimatedItemSize={52}
        keyExtractor={(item) => item.id}
      />
    </View>
  );
}
