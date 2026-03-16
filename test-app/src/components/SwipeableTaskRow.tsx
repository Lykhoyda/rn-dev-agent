import React, { useRef } from 'react';
import { Animated, PanResponder, Pressable, Text, View } from 'react-native';
import { useDispatch } from 'react-redux';
import type { TaskItem, TaskPriority } from '../store/slices/tasksSlice';
import { toggleTask, cyclePriority } from '../store/slices/tasksSlice';
import { PRIORITY_STYLES } from '../constants/taskStyles';
import type { ThemeColors } from '../hooks/useThemeColors';

const SWIPE_THRESHOLD = -80;
const SWIPE_MAX = -100;

interface Props {
  item: TaskItem;
  colors: ThemeColors;
  onDelete: (id: string) => void;
  onNavigate: (id: string) => void;
}

export default function SwipeableTaskRow({ item, colors, onDelete, onNavigate }: Props) {
  const dispatch = useDispatch();
  const translateX = useRef(new Animated.Value(0)).current;

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, { dx, dy }) =>
        Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 5,
      onMoveShouldSetPanResponderCapture: (_, { dx, dy }) =>
        Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 5,
      onPanResponderMove: (_, { dx }) => {
        const clamped = Math.max(SWIPE_MAX, Math.min(0, dx));
        translateX.setValue(clamped);
      },
      onPanResponderRelease: (_, { dx }) => {
        if (dx < SWIPE_THRESHOLD) {
          Animated.timing(translateX, {
            toValue: SWIPE_MAX,
            duration: 150,
            useNativeDriver: true,
          }).start(() => {
            onDelete(item.id);
            translateX.setValue(0);
          });
        } else {
          Animated.spring(translateX, {
            toValue: 0,
            useNativeDriver: true,
          }).start();
        }
      },
    }),
  ).current;

  const ps = PRIORITY_STYLES[item.priority];

  return (
    <View
      testID={`task-row-swipeable-${item.id}`}
      className="mb-2 overflow-hidden rounded-lg"
    >
      <View
        testID={`task-delete-zone-${item.id}`}
        className="absolute bottom-0 right-0 top-0 w-20 items-center justify-center bg-red-500"
      >
        <Text className="font-semibold text-white">Delete</Text>
      </View>

      <Animated.View
        style={{ transform: [{ translateX }] }}
        {...panResponder.panHandlers}
      >
        <View
          testID={`task-item-${item.id}`}
          className={`flex-row items-center p-4 ${item.done ? colors.card : `${colors.bg} border ${colors.border}`}`}
        >
          <Pressable
            testID={`task-toggle-${item.id}`}
            className={`h-6 w-6 rounded-full border-2 items-center justify-center ${item.done ? 'border-green-500 bg-green-500' : colors.border}`}
            onPress={() => dispatch(toggleTask(item.id))}
          >
            {item.done && <Text className="text-xs text-white">✓</Text>}
          </Pressable>

          <Pressable
            testID={`task-priority-${item.id}`}
            className={`ml-2 rounded-full px-2 py-0.5 ${ps.bg}`}
            onPress={() => dispatch(cyclePriority(item.id))}
          >
            <Text className={`text-xs font-semibold ${ps.text}`}>{ps.label}</Text>
          </Pressable>

          <Pressable
            testID={`task-row-pressable-${item.id}`}
            className="ml-2 flex-1"
            onPress={() => onNavigate(item.id)}
          >
            <Text
              testID={`task-title-${item.id}`}
              className={`${item.done ? colors.muted : colors.text} ${item.done ? 'line-through' : ''}`}
            >
              {item.title}
            </Text>
          </Pressable>

          {!item.synced && (
            <View testID={`task-unsynced-${item.id}`} className="mr-2 h-2 w-2 rounded-full bg-orange-400" />
          )}

          <Pressable
            testID={`task-remove-${item.id}`}
            className="ml-2 h-6 w-6 items-center justify-center rounded-full bg-red-100"
            onPress={() => onDelete(item.id)}
          >
            <Text className="text-xs text-red-500">✕</Text>
          </Pressable>
        </View>
      </Animated.View>
    </View>
  );
}
