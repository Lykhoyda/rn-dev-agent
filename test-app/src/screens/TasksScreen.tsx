import React, { useCallback, useState } from 'react';
import { View, Text, TextInput, Pressable, FlatList } from 'react-native';
import { useSelector, useDispatch } from 'react-redux';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { TasksStackParams } from '../navigation/types';
import {
  addTask,
  setFilter,
  markAllSynced,
  toggleSort,
  softDelete,
  selectSortedFilteredTasks,
  selectUnsyncedCount,
  selectActiveTaskCount,
  selectCurrentFilter,
  selectCurrentSort,
} from '../store/slices/tasksSlice';
import type { TaskFilter, TaskItem } from '../store/slices/tasksSlice';
import { useThemeColors } from '../hooks/useThemeColors';
import SwipeableTaskRow from '../components/SwipeableTaskRow';
import UndoSnackbar from '../components/UndoSnackbar';

const API_BASE = 'https://api.testapp.local';

const FILTERS: { key: TaskFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'done', label: 'Done' },
];

type Props = NativeStackScreenProps<TasksStackParams, 'TasksMain'>;

export default function TasksScreen({ navigation }: Props) {
  const dispatch = useDispatch();
  const [text, setText] = useState('');
  const filteredTasks = useSelector(selectSortedFilteredTasks);
  const currentFilter = useSelector(selectCurrentFilter);
  const currentSort = useSelector(selectCurrentSort);
  const unsyncedCount = useSelector(selectUnsyncedCount);
  const activeCount = useSelector(selectActiveTaskCount);
  const colors = useThemeColors();

  const handleAdd = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    dispatch(addTask(trimmed));
    setText('');
  };

  const handleSync = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/tasks/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: unsyncedCount }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      dispatch(markAllSynced());
    } catch (err) {
      if (__DEV__) console.error('[Tasks] sync failed:', err);
    }
  };

  const handleSwipeDelete = useCallback((id: string) => {
    dispatch(softDelete(id));
  }, [dispatch]);

  const handleNavigate = useCallback((id: string) => {
    navigation.navigate('TaskDetail', { id });
  }, [navigation]);

  const renderItem = useCallback(({ item }: { item: TaskItem }) => (
    <SwipeableTaskRow
      item={item}
      colors={colors}
      onDelete={handleSwipeDelete}
      onNavigate={handleNavigate}
    />
  ), [colors, handleSwipeDelete, handleNavigate]);

  return (
    <View testID="task-screen" className={`relative flex-1 ${colors.bg} px-4 pt-4`}>
      <Text testID="task-header" className={`text-xl font-bold ${colors.text}`}>
        Tasks ({activeCount} active)
      </Text>

      <View className="mt-3 flex-row gap-2">
        <TextInput
          testID="task-input"
          className={`flex-1 rounded-lg border ${colors.border} px-3 py-2 ${colors.text}`}
          placeholder="Add a task..."
          placeholderTextColor={colors.placeholderColor}
          value={text}
          onChangeText={setText}
          onSubmitEditing={handleAdd}
          returnKeyType="done"
        />
        <Pressable
          testID="task-add-btn"
          className="rounded-lg bg-blue-500 px-4 py-2 justify-center"
          onPress={handleAdd}
        >
          <Text className="font-semibold text-white">Add</Text>
        </Pressable>
      </View>

      <View testID="task-filters" className="mt-3 flex-row flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Pressable
            key={f.key}
            testID={`task-filter-${f.key}`}
            className={`rounded-full px-4 py-1.5 ${currentFilter === f.key ? 'bg-blue-500' : colors.card}`}
            onPress={() => dispatch(setFilter(f.key))}
          >
            <Text className={currentFilter === f.key ? 'font-semibold text-white' : colors.text}>
              {f.label}
            </Text>
          </Pressable>
        ))}
        <Pressable
          testID="task-sort-btn"
          className={`rounded-full px-4 py-1.5 ${currentSort === 'priority' ? 'bg-purple-500' : colors.card}`}
          onPress={() => dispatch(toggleSort())}
        >
          <Text
            testID="task-sort-label"
            className={currentSort === 'priority' ? 'font-semibold text-white' : colors.text}
          >
            {currentSort === 'priority' ? 'Sort: Priority' : 'Sort: Default'}
          </Text>
        </Pressable>
      </View>

      {filteredTasks.length === 0 ? (
        <View testID="task-empty" className="flex-1 items-center justify-center">
          <Text className={`text-lg ${colors.muted}`}>
            {currentFilter === 'all' ? 'No tasks yet' : `No ${currentFilter} tasks`}
          </Text>
        </View>
      ) : (
        <FlatList
          testID="task-list"
          className="mt-4"
          data={filteredTasks}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          keyboardShouldPersistTaps="handled"
        />
      )}

      <View className="pb-4 pt-2">
        <Pressable
          testID="task-sync-btn"
          className={`rounded-lg px-4 py-3 ${unsyncedCount > 0 ? 'bg-indigo-500' : 'bg-gray-300'}`}
          onPress={handleSync}
          disabled={unsyncedCount === 0}
        >
          <Text className="text-center font-semibold text-white">
            {unsyncedCount > 0 ? `Sync ${unsyncedCount} change${unsyncedCount > 1 ? 's' : ''}` : 'All synced'}
          </Text>
        </Pressable>
      </View>

      <UndoSnackbar />
    </View>
  );
}
