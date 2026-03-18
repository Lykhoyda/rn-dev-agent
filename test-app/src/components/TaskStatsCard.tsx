import React, { useEffect } from 'react';
import { View, Text } from 'react-native';
import Animated, {
  FadeInDown,
  useSharedValue,
  useAnimatedStyle,
  withTiming,
} from 'react-native-reanimated';
import { useSelector } from 'react-redux';
import { selectTaskStats, selectPriorityDistribution } from '../store/slices/tasksSlice';
import { useThemeColors } from '../hooks/useThemeColors';

const PRIORITY_COLORS = {
  high: 'bg-red-500',
  medium: 'bg-amber-500',
  low: 'bg-green-500',
} as const;

export default function TaskStatsCard() {
  const colors = useThemeColors();
  const stats = useSelector(selectTaskStats);
  const priority = useSelector(selectPriorityDistribution);

  const progressRatio = useSharedValue(0);

  useEffect(() => {
    progressRatio.value = stats.total > 0 ? stats.done / stats.total : 0;
  }, [stats.done, stats.total]);

  const progressStyle = useAnimatedStyle(() => ({
    transform: [{ scaleX: withTiming(progressRatio.value, { duration: 600 }) }],
  }));

  return (
    <View
      testID="task-stats-card"
      className={`mt-3 rounded-lg p-4 ${colors.card}`}
      style={{ borderCurve: 'continuous', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}
    >
      <Animated.View entering={FadeInDown.duration(400)}>
        <Text testID="task-stats-title" className={`text-sm font-bold uppercase tracking-wide ${colors.muted}`}>
          Task Overview
        </Text>
      </Animated.View>

      <Animated.View
        entering={FadeInDown.duration(400).delay(100)}
        className="mt-3 flex-row justify-between"
      >
        <View testID="task-stats-total" className="items-center">
          <Text className={`text-2xl font-bold ${colors.text}`}>{stats.total}</Text>
          <Text className={`text-xs ${colors.muted}`}>Total</Text>
        </View>
        <View testID="task-stats-active" className="items-center">
          <Text className="text-2xl font-bold text-blue-500">{stats.active}</Text>
          <Text className={`text-xs ${colors.muted}`}>Active</Text>
        </View>
        <View testID="task-stats-done" className="items-center">
          <Text className="text-2xl font-bold text-green-500">{stats.done}</Text>
          <Text className={`text-xs ${colors.muted}`}>Done</Text>
        </View>
      </Animated.View>

      <Animated.View entering={FadeInDown.duration(400).delay(200)} className="mt-3">
        <View testID="task-stats-progress-bg" className="h-2 rounded-full bg-gray-200 overflow-hidden">
          <Animated.View
            testID="task-stats-progress-fill"
            className="h-2 rounded-full bg-green-500"
            style={[{ transformOrigin: 'left', width: '100%' }, progressStyle]}
          />
        </View>
        <Text testID="task-stats-progress-label" className={`mt-1 text-xs ${colors.muted}`}>
          {stats.total > 0 ? `${Math.round((stats.done / stats.total) * 100)}% complete` : 'No tasks yet'}
        </Text>
      </Animated.View>

      <Animated.View
        entering={FadeInDown.duration(400).delay(300)}
        className="mt-3 flex-row gap-4"
      >
        <View testID="task-stats-priority-high" className="flex-row items-center gap-1.5">
          <View className={`h-2.5 w-2.5 rounded-full ${PRIORITY_COLORS.high}`} />
          <Text className={`text-xs ${colors.muted}`}>High {priority.high}</Text>
        </View>
        <View testID="task-stats-priority-medium" className="flex-row items-center gap-1.5">
          <View className={`h-2.5 w-2.5 rounded-full ${PRIORITY_COLORS.medium}`} />
          <Text className={`text-xs ${colors.muted}`}>Med {priority.medium}</Text>
        </View>
        <View testID="task-stats-priority-low" className="flex-row items-center gap-1.5">
          <View className={`h-2.5 w-2.5 rounded-full ${PRIORITY_COLORS.low}`} />
          <Text className={`text-xs ${colors.muted}`}>Low {priority.low}</Text>
        </View>
      </Animated.View>
    </View>
  );
}
