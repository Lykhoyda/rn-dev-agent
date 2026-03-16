import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, Pressable, FlatList, Animated } from 'react-native';
import Reanimated, { SlideInRight, FadeOut, Layout } from 'react-native-reanimated';
import { useSelector, useDispatch } from 'react-redux';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackScreenProps, NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { TasksStackParams, RootStackParams } from '../navigation/types';
import {
  addTask,
  setFilter,
  markAllSynced,
  toggleSort,
  softDelete,
  shuffleTasks,
  selectSortedFilteredTasks,
  selectUnsyncedCount,
  selectActiveTaskCount,
  selectCurrentFilter,
  selectCurrentSort,
} from '../store/slices/tasksSlice';
import type { TaskFilter, TaskItem } from '../store/slices/tasksSlice';
import type BottomSheetType from '@gorhom/bottom-sheet';
import { useThemeColors } from '../hooks/useThemeColors';
import SwipeableTaskRow from '../components/SwipeableTaskRow';
import UndoSnackbar from '../components/UndoSnackbar';
import TaskBottomSheet from '../components/TaskBottomSheet';

const API_BASE = 'https://api.testapp.local';

const FILTERS: { key: TaskFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'done', label: 'Done' },
];

type Props = NativeStackScreenProps<TasksStackParams, 'TasksMain'>;

export default function TasksScreen({ navigation }: Props) {
  const dispatch = useDispatch();
  const rootNav = useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const [text, setText] = useState('');
  const fabScale = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.spring(fabScale, {
      toValue: 1,
      friction: 5,
      useNativeDriver: true,
    }).start();
  }, [fabScale]);
  const sheetRef = useRef<BottomSheetType>(null);
  const [selectedTask, setSelectedTask] = useState<TaskItem | null>(null);
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
    const task = filteredTasks.find(t => t.id === id);
    if (task) {
      setSelectedTask(task);
      sheetRef.current?.snapToIndex(1);
    }
  }, [filteredTasks]);

  const renderItem = useCallback(({ item }: { item: TaskItem }) => (
    <Reanimated.View
      testID={`task-row-animated-${item.id}`}
      entering={SlideInRight.duration(300)}
      exiting={FadeOut.duration(200)}
      layout={Layout.springify()}
    >
      <SwipeableTaskRow
        item={item}
        colors={colors}
        onDelete={handleSwipeDelete}
        onNavigate={handleNavigate}
      />
    </Reanimated.View>
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
        <Pressable
          testID="shuffle-btn"
          className={`rounded-full px-4 py-1.5 bg-orange-500`}
          onPress={() => dispatch(shuffleTasks())}
        >
          <Text className="font-semibold text-white">Shuffle</Text>
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

      <TaskBottomSheet
        ref={sheetRef}
        task={selectedTask}
        onDismiss={() => setSelectedTask(null)}
      />

      {/* FAB */}
      <Animated.View
        style={{ transform: [{ scale: fabScale }], position: 'absolute', bottom: 90, right: 20, elevation: 8 }}
      >
        <Pressable
          testID="fab-create-task"
          onPress={() => rootNav.navigate('TaskWizard')}
          className="h-14 w-14 items-center justify-center rounded-full bg-blue-500"
          style={{ shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 4 }}
        >
          <Text className="text-2xl font-bold text-white">+</Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}
