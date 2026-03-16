import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { View, Text, TextInput, Pressable, ActivityIndicator, FlatList, RefreshControl } from 'react-native';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useSelector } from 'react-redux';
import { useThemeColors } from '../hooks/useThemeColors';
import { selectIsOffline } from '../store/slices/networkSlice';

const API_BASE = 'https://api.testapp.local';

interface FeedItem {
  id: string;
  author: string;
  title: string;
  body: string;
  avatar: string;
}

interface FeedPage {
  items: FeedItem[];
  nextPage: number | null;
  hasMore: boolean;
}

async function fetchFeedPage({ pageParam = 1 }: { pageParam?: number }): Promise<FeedPage> {
  const res = await fetch(`${API_BASE}/api/feed?page=${pageParam}&limit=5`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export default function FeedScreen() {
  const colors = useThemeColors();
  const isOffline = useSelector(selectIsOffline);
  const [searchText, setSearchText] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(searchText), 300);
    return () => clearTimeout(timer);
  }, [searchText]);

  const {
    data,
    isLoading,
    isError,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    refetch,
    isRefetching,
    dataUpdatedAt,
  } = useInfiniteQuery({
    queryKey: ['feed'],
    queryFn: fetchFeedPage,
    initialPageParam: 1,
    getNextPageParam: (lastPage) => lastPage.nextPage,
    enabled: !isOffline,
  });

  const allItems = useMemo(() => {
    if (!data?.pages) return [];
    return data.pages.flatMap((page) => page.items);
  }, [data]);

  const filteredItems = useMemo(() => {
    if (!debouncedQuery) return allItems;
    const lower = debouncedQuery.toLowerCase();
    return allItems.filter(
      (item) => item.title.toLowerCase().includes(lower) || item.body.toLowerCase().includes(lower),
    );
  }, [allItems, debouncedQuery]);

  const cacheAge = dataUpdatedAt ? Date.now() - dataUpdatedAt : null;
  const cacheStatus = isLoading || isFetchingNextPage || isRefetching
    ? 'Fetching...'
    : cacheAge !== null && cacheAge < 30000
      ? 'Fresh'
      : 'Stale';

  const handleEndReached = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const renderItem = useCallback(({ item }: { item: FeedItem }) => (
    <View testID={`feed-item-${item.id}`} className={`mb-3 rounded-lg p-4 ${colors.card}`}>
      <Text className={`font-semibold ${colors.text}`}>{item.title}</Text>
      <Text className={`mt-1 text-sm ${colors.muted}`}>{item.body}</Text>
      <Text className={`mt-1 text-xs ${colors.muted}`}>by {item.author}</Text>
    </View>
  ), [colors]);

  const pageCount = data?.pages?.length ?? 0;

  return (
    <View testID="feed-screen" className={`flex-1 ${colors.bg} px-4 pt-4`}>
      <View className="mb-2 flex-row items-center justify-between">
        <View className={`flex-1 mr-2 flex-row items-center rounded-lg border ${colors.border} ${colors.card}`}>
          <TextInput
            testID="feed-search-input"
            className={`flex-1 px-3 py-2 text-base ${colors.text}`}
            placeholder="Search posts..."
            placeholderTextColor={colors.placeholderColor}
            value={searchText}
            onChangeText={setSearchText}
            autoCorrect={false}
            autoCapitalize="none"
          />
          {searchText.length > 0 && (
            <Pressable testID="feed-search-clear" className="px-3 py-2" onPress={() => { setSearchText(''); setDebouncedQuery(''); }}>
              <Text className={`text-base ${colors.muted}`}>✕</Text>
            </Pressable>
          )}
        </View>
        <View testID="feed-cache-badge" className={`rounded-full px-3 py-1 ${cacheStatus === 'Fresh' ? 'bg-green-100' : cacheStatus === 'Stale' ? 'bg-yellow-100' : 'bg-blue-100'}`}>
          <Text className={`text-xs font-medium ${cacheStatus === 'Fresh' ? 'text-green-700' : cacheStatus === 'Stale' ? 'text-yellow-700' : 'text-blue-700'}`}>
            {cacheStatus}
          </Text>
        </View>
      </View>

      <Text testID="feed-page-indicator" className={`mb-2 text-xs ${colors.muted}`}>
        {allItems.length} posts loaded ({pageCount} page{pageCount !== 1 ? 's' : ''})
      </Text>

      {isLoading && (
        <View testID="feed-loading" className="items-center py-8">
          <ActivityIndicator size="large" />
        </View>
      )}

      {isError && (
        <View testID="feed-error" className="rounded-lg bg-red-100 p-4">
          <Text className="text-red-700">{error instanceof Error ? error.message : 'Unknown error'}</Text>
          <Pressable testID="feed-retry-btn" className="mt-2 rounded bg-red-500 px-3 py-2" onPress={() => refetch()}>
            <Text className="text-center text-white">Retry</Text>
          </Pressable>
        </View>
      )}

      {isOffline && !isLoading && !isError && (
        <View testID="feed-offline-msg" className="mb-3 rounded-lg bg-yellow-100 p-4">
          <Text className="text-yellow-800">You are offline. Data may be stale.</Text>
        </View>
      )}

      {!isLoading && !isError && (
        <FlatList
          testID="feed-list"
          className="flex-1"
          data={filteredItems}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          keyboardShouldPersistTaps="handled"
          onEndReached={handleEndReached}
          onEndReachedThreshold={0.5}
          refreshControl={
            <RefreshControl refreshing={isRefetching && !isFetchingNextPage} onRefresh={() => refetch()} />
          }
          ListFooterComponent={
            isFetchingNextPage ? (
              <View testID="feed-loading-more" className="items-center py-4">
                <ActivityIndicator size="small" />
                <Text className={`mt-1 text-xs ${colors.muted}`}>Loading more...</Text>
              </View>
            ) : null
          }
          ListEmptyComponent={
            <View testID="feed-no-results" className="items-center pt-16">
              <Text className={`text-lg ${colors.muted}`}>
                {debouncedQuery.length > 0 ? 'No results' : 'No posts yet'}
              </Text>
            </View>
          }
        />
      )}
    </View>
  );
}
