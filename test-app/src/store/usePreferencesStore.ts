import { create } from 'zustand';

export type FontSize = 'small' | 'medium' | 'large';

interface PreferencesState {
  fontSize: FontSize;
  compactMode: boolean;
  accentColor: string;
  setFontSize: (size: FontSize) => void;
  toggleCompactMode: () => void;
  setAccentColor: (color: string) => void;
}

export const usePreferencesStore = create<PreferencesState>((set) => ({
  fontSize: 'medium',
  compactMode: false,
  accentColor: '#3b82f6',
  setFontSize: (size) => set({ fontSize: size }),
  toggleCompactMode: () => set((s) => ({ compactMode: !s.compactMode })),
  setAccentColor: (color) => set({ accentColor: color }),
}));

if (__DEV__) {
  (globalThis as Record<string, unknown>).__ZUSTAND_STORES__ = {
    preferences: usePreferencesStore,
  };
}
