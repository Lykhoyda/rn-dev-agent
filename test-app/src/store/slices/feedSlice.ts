import { createSlice } from '@reduxjs/toolkit';
import type { PayloadAction } from '@reduxjs/toolkit';

export interface FeedItem {
  id: string;
  title: string;
  body: string;
}

interface FeedState {
  items: FeedItem[];
  loading: boolean;
  error: string | null;
  lastFetched: number | null;
}

const initialState: FeedState = {
  items: [],
  loading: false,
  error: null,
  lastFetched: null,
};

const feedSlice = createSlice({
  name: 'feed',
  initialState,
  reducers: {
    setLoading: (state, action: PayloadAction<boolean>) => {
      state.loading = action.payload;
    },
    setItems: (state, action: PayloadAction<FeedItem[]>) => {
      state.items = action.payload;
      state.loading = false;
      state.error = null;
      state.lastFetched = Date.now();
    },
    setError: (state, action: PayloadAction<string>) => {
      state.error = action.payload;
      state.loading = false;
    },
  },
});

export const { setLoading, setItems, setError } = feedSlice.actions;

export const selectLastFetched = (state: { feed: FeedState }) =>
  state.feed.lastFetched;

export function formatRelativeTime(ts: number | null): string {
  if (ts === null) return '';
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

export default feedSlice;
