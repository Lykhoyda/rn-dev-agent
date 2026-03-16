import { createSlice } from '@reduxjs/toolkit';
import type { PayloadAction } from '@reduxjs/toolkit';

interface SettingsState {
  theme: 'light' | 'dark';
  language: 'en' | 'de';
  lastSynced: number | null;
  onboardingComplete: boolean;
}

const initialState: SettingsState = {
  theme: 'light',
  language: 'en',
  lastSynced: null,
  onboardingComplete: false,
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
    completeOnboarding: (state) => {
      state.onboardingComplete = true;
    },
  },
});

export const { toggleTheme, setLanguage, setLastSynced, completeOnboarding } = settingsSlice.actions;

export const selectLastSynced = (state: { settings: SettingsState }) =>
  state.settings.lastSynced;

export default settingsSlice;
