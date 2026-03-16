import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { useSelector, useDispatch } from 'react-redux';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootState } from '../store';
import type { TasksStackParams } from '../navigation/types';
import { toggleTask, cyclePriority } from '../store/slices/tasksSlice';
import { PRIORITY_STYLES } from '../constants/taskStyles';
import { useThemeColors } from '../hooks/useThemeColors';

type Props = NativeStackScreenProps<TasksStackParams, 'TaskDetail'>;

export default function TaskDetailScreen({ route, navigation }: Props) {
  const { id } = route.params;
  const dispatch = useDispatch();
  const colors = useThemeColors();
  const item = useSelector((state: RootState) =>
    state.tasks.items.find((t) => t.id === id),
  );

  if (!item) {
    return (
      <View testID="task-detail-empty" className={`flex-1 items-center justify-center ${colors.bg}`}>
        <Text className={`text-lg ${colors.muted}`}>Task not found</Text>
        <Pressable
          testID="task-detail-back-btn"
          className="mt-4 rounded-lg bg-blue-500 px-4 py-3"
          onPress={() => navigation.goBack()}
        >
          <Text className="text-center font-semibold text-white">Go Back</Text>
        </Pressable>
      </View>
    );
  }

  const ps = PRIORITY_STYLES[item.priority];

  return (
    <View testID="task-detail-screen" className={`flex-1 ${colors.bg} px-4 pt-6`}>
      <Text testID="task-detail-title" className={`text-2xl font-bold ${colors.text}`}>
        {item.title}
      </Text>

      <View className="mt-4 flex-row items-center gap-3">
        <View testID="task-detail-priority" className={`rounded-full px-3 py-1 ${ps.bg}`}>
          <Text className={`text-sm font-semibold ${ps.text}`}>{ps.label}</Text>
        </View>

        <View className={`rounded-full px-3 py-1 ${item.done ? 'bg-green-100' : 'bg-gray-100'}`}>
          <Text className={`text-sm font-semibold ${item.done ? 'text-green-700' : 'text-gray-600'}`}>
            {item.done ? 'Done' : 'Active'}
          </Text>
        </View>

        {!item.synced && (
          <View className="rounded-full bg-orange-100 px-3 py-1">
            <Text className="text-sm font-semibold text-orange-700">Unsynced</Text>
          </View>
        )}
      </View>

      <View className="mt-6 gap-3">
        <Pressable
          testID="task-detail-toggle-done"
          className={`rounded-lg px-4 py-3 ${item.done ? 'bg-gray-500' : 'bg-green-500'}`}
          onPress={() => dispatch(toggleTask(id))}
        >
          <Text className="text-center font-semibold text-white">
            {item.done ? 'Mark Active' : 'Mark Done'}
          </Text>
        </Pressable>

        <Pressable
          testID="task-detail-cycle-priority"
          className="rounded-lg bg-purple-500 px-4 py-3"
          onPress={() => dispatch(cyclePriority(id))}
        >
          <Text className="text-center font-semibold text-white">
            Cycle Priority ({ps.label})
          </Text>
        </Pressable>
      </View>

      <Pressable
        testID="task-detail-back-btn"
        className={`mt-4 rounded-lg ${colors.card} px-4 py-3`}
        onPress={() => navigation.goBack()}
      >
        <Text className={`text-center font-semibold ${colors.text}`}>Back to List</Text>
      </Pressable>
    </View>
  );
}
