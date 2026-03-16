import { createSlice } from '@reduxjs/toolkit';
import type { PayloadAction } from '@reduxjs/toolkit';

interface SettingsState {
  theme: 'light' | 'dark';
  language: 'en' | 'de';
  lastSynced: number | null;
}

const initialState: SettingsState = {
  theme: 'light',
  language: 'en',
  lastSynced: null,
};

const settingsSlice = createSlice({
  name: 'settings',
  initialState,
  reducers: {
    toggleTheme: (state) => {
      state.theme = state.theme === 'light' ? 'dark' : 'light';
    },
    setLanguage: (state, action: PayloadAction<'en' | 'de'>) => {
      state.language = action.payload;
    },
    setLastSynced: (state, action: PayloadAction<number>) => {
      state.lastSynced = action.payload;
    },
  },
});

export const { toggleTheme, setLanguage, setLastSynced } = settingsSlice.actions;

export const selectLastSynced = (state: { settings: SettingsState }) =>
  state.settings.lastSynced;

export default settingsSlice;
