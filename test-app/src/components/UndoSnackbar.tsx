import React, { useEffect, useRef } from 'react';
import { LayoutAnimation, Pressable, Text, View } from 'react-native';
import { useSelector, useDispatch } from 'react-redux';
import { selectPendingDelete, restoreTask, commitDelete } from '../store/slices/tasksSlice';
import { useThemeColors } from '../hooks/useThemeColors';

const UNDO_TIMEOUT = 5000;

export default function UndoSnackbar() {
  const dispatch = useDispatch();
  const pendingDelete = useSelector(selectPendingDelete);
  const colors = useThemeColors();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    if (pendingDelete) {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      timerRef.current = setTimeout(() => {
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        dispatch(commitDelete());
        timerRef.current = null;
      }, UNDO_TIMEOUT);
    }

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [pendingDelete?.id, dispatch]);

  const handleUndo = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    dispatch(restoreTask());
  };

  if (!pendingDelete) return null;

  return (
    <View
      testID="undo-snackbar"
      className="absolute bottom-20 left-4 right-4 flex-row items-center justify-between rounded-lg bg-gray-800 px-4 py-3"
      style={{ elevation: 6 }}
    >
      <Text className="flex-1 text-white">
        Deleted "{pendingDelete.task.title}"
      </Text>
      <Pressable
        testID="undo-btn"
        className="ml-3 rounded bg-white/20 px-3 py-1"
        onPress={handleUndo}
      >
        <Text className="font-semibold text-white">Undo</Text>
      </Pressable>
    </View>
  );
}
