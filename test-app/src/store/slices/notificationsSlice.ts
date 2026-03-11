import { createSlice } from '@reduxjs/toolkit';
import type { PayloadAction } from '@reduxjs/toolkit';

export interface NotificationItem {
  id: string;
  title: string;
  read: boolean;
}

interface NotificationsState {
  items: NotificationItem[];
  unreadCount: number;
}

const initialState: NotificationsState = {
  items: [
    { id: '1', title: 'Welcome to the test app', read: false },
    { id: '2', title: 'Your profile is set up', read: false },
    { id: '3', title: 'Try the Error Lab', read: true },
  ],
  unreadCount: 2,
};

const notificationsSlice = createSlice({
  name: 'notifications',
  initialState,
  reducers: {
    markAllRead: (state) => {
      state.items.forEach((item) => { item.read = true; });
      state.unreadCount = 0;
    },
    markRead: (state, action: PayloadAction<string>) => {
      const item = state.items.find((i) => i.id === action.payload);
      if (item && !item.read) {
        item.read = true;
        state.unreadCount = Math.max(0, state.unreadCount - 1);
      }
    },
  },
});

export const { markAllRead, markRead } = notificationsSlice.actions;
export default notificationsSlice;
