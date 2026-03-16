import React, { useState, useRef, useCallback, useEffect } from 'react';
import { View, Text, Pressable, Dimensions, ScrollView } from 'react-native';
import Reanimated, { FadeIn, SlideInUp } from 'react-native-reanimated';
import { useDispatch } from 'react-redux';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParams } from '../navigation/types';
import type { AppDispatch } from '../store';
import { completeOnboarding } from '../store/slices/settingsSlice';

type Props = NativeStackScreenProps<RootStackParams, 'Onboarding'>;

const { width: SCREEN_WIDTH } = Dimensions.get('window');

const PAGES = [
  { title: 'Welcome', subtitle: 'Your AI-powered dev partner', color: '#3b82f6', radius: 60 },
  { title: 'Explore', subtitle: 'Understand your codebase deeply', color: '#22c55e', radius: 16 },
  { title: 'Build', subtitle: 'Implement features with confidence', color: '#a855f7', radius: 30 },
  { title: 'Verify', subtitle: 'Prove it works on the simulator', color: '#ef4444', radius: 8 },
];

export default function OnboardingScreen({ navigation }: Props) {
  const dispatch = useDispatch<AppDispatch>();
  const [currentPage, setCurrentPage] = useState(0);
  const scrollRef = useRef<ScrollView>(null);

  const goToPage = useCallback((page: number) => {
    scrollRef.current?.scrollTo({ x: page * SCREEN_WIDTH, animated: true });
    setCurrentPage(page);
  }, []);

  const handleDone = useCallback(() => {
    dispatch(completeOnboarding());
    navigation.replace('Tabs');
  }, [dispatch, navigation]);

  const handleScroll = useCallback((e: { nativeEvent: { contentOffset: { x: number } } }) => {
    const page = Math.round(e.nativeEvent.contentOffset.x / SCREEN_WIDTH);
    if (page !== currentPage && page >= 0 && page < PAGES.length) {
      setCurrentPage(page);
    }
  }, [currentPage]);

  return (
    <View testID="onboarding-screen" className="flex-1 bg-white">
      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={handleScroll}
        scrollEventThrottle={16}
      >
        {PAGES.map((page, i) => (
          <View key={i} testID={`onboarding-page-${i}`} style={{ width: SCREEN_WIDTH }} className="flex-1 items-center justify-center px-8">
            <Reanimated.View
              entering={FadeIn.delay(i * 200).duration(600)}
            >
              <View
                style={{
                  width: 120,
                  height: 120,
                  backgroundColor: page.color,
                  borderRadius: page.radius,
                }}
              />
            </Reanimated.View>
            <Reanimated.View entering={SlideInUp.delay(300 + i * 200).duration(500)}>
              <Text className="mt-8 text-center text-2xl font-bold text-gray-900">{page.title}</Text>
              <Text className="mt-2 text-center text-base text-gray-500">{page.subtitle}</Text>
            </Reanimated.View>
          </View>
        ))}
      </ScrollView>

      <View testID="onboarding-dots" className="flex-row items-center justify-center py-4">
        {PAGES.map((_, i) => (
          <View
            key={i}
            style={{
              width: currentPage === i ? 24 : 8,
              height: 8,
              borderRadius: 4,
              marginHorizontal: 4,
              backgroundColor: currentPage === i ? '#3b82f6' : '#d1d5db',
            }}
          />
        ))}
      </View>

      <View className="flex-row items-center justify-between px-6 pb-12">
        {currentPage < PAGES.length - 1 ? (
          <>
            <Pressable testID="onboarding-skip" onPress={() => goToPage(PAGES.length - 1)}>
              <Text className="text-base text-gray-400">Skip</Text>
            </Pressable>
            <Pressable
              testID="onboarding-next"
              onPress={() => goToPage(currentPage + 1)}
              className="rounded-full bg-blue-500 px-8 py-3"
            >
              <Text className="font-semibold text-white">Next</Text>
            </Pressable>
          </>
        ) : (
          <Pressable
            testID="onboarding-done"
            onPress={handleDone}
            className="flex-1 rounded-full bg-blue-500 py-4"
          >
            <Text className="text-center text-base font-semibold text-white">Get Started</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}
