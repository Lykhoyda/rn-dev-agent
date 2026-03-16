import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { View, Text, TextInput, Pressable, ActivityIndicator, FlatList } from 'react-native';
import { useDispatch, useSelector } from 'react-redux';
import type { RootState, AppDispatch } from '../store';
import { setLoading, setItems, setError } from '../store/slices/feedSlice';
import type { FeedItem } from '../store/slices/feedSlice';
import { useThemeColors } from '../hooks/useThemeColors';
import { selectIsOffline } from '../store/slices/networkSlice';

const API_BASE = 'https://api.testapp.local';

export default function FeedScreen() {
  const dispatch = useDispatch<AppDispatch>();
  const items = useSelector((state: RootState) => state.feed.items);
  const loading = useSelector((state: RootState) => state.feed.loading);
  const error = useSelector((state: RootState) => state.feed.error);
  const isOffline = useSelector(selectIsOffline);
  const isOfflineRef = useRef(isOffline);
  const [searchText, setSearchText] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const colors = useThemeColors();

  useEffect(() => { isOfflineRef.current = isOffline; }, [isOffline]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(searchText);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchText]);

  const fetchFeed = useCallback(async (triggerError = false) => {
    if (isOfflineRef.current) {
      dispatch(setError('You are offline'));
      return;
    }
    dispatch(setLoading(true));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const url = triggerError ? `${API_BASE}/api/feed?error=true` : `${API_BASE}/api/feed`;
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        const body = await res.json();
        dispatch(setError(body.message ?? 'Request failed'));
        return;
      }
      const data: FeedItem[] = await res.json();
      dispatch(setItems(data));
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        dispatch(setError('Request timed out'));
      } else {
        dispatch(setError(err instanceof Error ? err.message : 'Unknown error'));
      }
    } finally {
      clearTimeout(timeout);
    }
  }, [dispatch]);

  useEffect(() => {
    if (!isOffline) {
      void fetchFeed();
    }
  }, [fetchFeed, isOffline]);

  const filteredItems = useMemo(() => {
    if (!debouncedQuery) return items;
    const lower = debouncedQuery.toLowerCase();
    return items.filter(
      (item) =>
        item.title.toLowerCase().includes(lower) ||
        item.body.toLowerCase().includes(lower),
    );
  }, [items, debouncedQuery]);

  const renderItem = useCallback(({ item }: { item: FeedItem }) => (
    <View testID={`feed-item-${item.id}`} className={`mb-3 rounded-lg p-4 ${colors.card}`}>
      <Text className={`font-semibold ${colors.text}`}>{item.title}</Text>
      <Text className={`mt-1 text-sm ${colors.muted}`}>{item.body}</Text>
    </View>
  ), [colors]);

  return (
    <View testID="feed-screen" className={`flex-1 ${colors.bg} px-4 pt-4`}>
      <View className={`mb-3 flex-row items-center rounded-lg border ${colors.border} ${colors.card}`}>
        <TextInput
          testID="feed-search-input"
          className={`flex-1 px-3 py-2 text-base ${colors.text}`}
          placeholder="Search posts..."
          placeholderTextColor={colors.placeholderColor}
          value={searchText}
          onChangeText={setSearchText}
          returnKeyType="search"
          autoCorrect={false}
          autoCapitalize="none"
        />
        {searchText.length > 0 && (
          <Pressable
            testID="feed-search-clear"
            className="px-3 py-2"
            onPress={() => {
              setSearchText('');
              setDebouncedQuery('');
            }}
          >
            <Text className={`text-base ${colors.muted}`}>✕</Text>
          </Pressable>
        )}
      </View>

      {loading && (
        <View testID="feed-loading" className="items-center py-8">
          <ActivityIndicator size="large" />
        </View>
      )}

      {error && (
        <View testID="feed-error" className="rounded-lg bg-red-100 p-4">
          <Text className="text-red-700">{error}</Text>
          <Pressable
            testID="feed-retry-btn"
            className="mt-2 rounded bg-red-500 px-3 py-2"
            onPress={() => fetchFeed()}
          >
            <Text className="text-center text-white">Retry</Text>
          </Pressable>
        </View>
      )}

      {isOffline && !loading && !error && (
        <View testID="feed-offline-msg" className="mb-3 rounded-lg bg-yellow-100 p-4">
          <Text className="text-yellow-800">You are offline. Data may be stale.</Text>
        </View>
      )}

      {!loading && !error && (
        <FlatList
          testID="feed-list"
          className="flex-1"
          data={filteredItems}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            <View testID="feed-no-results" className="flex-1 items-center justify-center pt-16">
              <Text className={`text-lg ${colors.muted}`}>
                {debouncedQuery.length > 0 ? 'No results' : 'No posts yet'}
              </Text>
            </View>
          }
        />
      )}

      <Pressable
        testID="feed-trigger-error-btn"
        className="mt-4 rounded-lg bg-orange-500 px-4 py-3"
        onPress={() => fetchFeed(true)}
      >
        <Text className="text-center font-semibold text-white">Trigger Error</Text>
      </Pressable>
    </View>
  );
}
