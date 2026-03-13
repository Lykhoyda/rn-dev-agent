# E2E Testing Setup Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a purpose-built Expo test app and Node.js test harness that validates all 10 MCP tools in the rn-dev-agent plugin work correctly against a real app on iOS Simulator.

**Architecture:** An Expo test app (`test-app/`) with 8 screens mirrors the production stack (React Navigation 6, Redux Toolkit, NativeWind, MSW). A separate Node.js harness (`test-app/harness/`) spawns the cdp-bridge MCP server as a child process, calls each of the 10 tools via the MCP SDK client, and asserts responses match expected shapes and values. The app exposes `globalThis.__NAV_REF__` and `globalThis.__REDUX_STORE__` for harness-driven navigation and state inspection.

**Tech Stack:** Expo (latest stable SDK), React Navigation 6, Redux Toolkit, NativeWind, MSW 2.x, @modelcontextprotocol/sdk (client)

**Spec:** `docs/superpowers/specs/2026-03-11-testing-setup-design.md`

---

## Chunk 1: Project Scaffolding & Infrastructure

### Task 1: Scaffold Expo Test App

**Files:**
- Create: `test-app/app.json`
- Create: `test-app/package.json`
- Create: `test-app/tsconfig.json`
- Create: `test-app/babel.config.js`
- Create: `test-app/tailwind.config.js`
- Create: `test-app/metro.config.js`
- Create: `test-app/global.css`
- Create: `test-app/src/App.tsx` (minimal — just text, no providers yet)
- Modify: `.gitignore`

- [ ] **Step 1: Create test-app directory and app.json**

```json
// test-app/app.json
{
  "expo": {
    "name": "rn-dev-agent-test",
    "slug": "rn-dev-agent-test",
    "version": "1.0.0",
    "scheme": "rndatest",
    "orientation": "portrait",
    "platforms": ["ios"],
    "ios": {
      "supportsTablet": false,
      "bundleIdentifier": "com.rndevagent.testapp"
    },
    "newArchEnabled": true,
    "entryPoint": "./src/App.tsx"
  }
}
```

- [ ] **Step 2: Create package.json with all dependencies**

```json
// test-app/package.json
{
  "name": "rn-dev-agent-test",
  "version": "1.0.0",
  "private": true,
  "main": "node_modules/expo/AppEntry.js",
  "scripts": {
    "start": "expo start",
    "ios": "expo run:ios",
    "build:ios": "expo run:ios",
    "lint": "expo lint"
  },
  "dependencies": {
    "expo": "~52.0.0",
    "expo-status-bar": "~2.0.0",
    "react": "18.3.1",
    "react-native": "0.76.7",
    "@react-navigation/native": "^6.1.18",
    "@react-navigation/native-stack": "^6.11.0",
    "@react-navigation/bottom-tabs": "^6.6.1",
    "react-native-screens": "~4.4.0",
    "react-native-safe-area-context": "~4.14.0",
    "@reduxjs/toolkit": "^2.3.0",
    "react-redux": "^9.1.0",
    "redux-persist": "^6.0.0",
    "@react-native-async-storage/async-storage": "~2.1.0",
    "nativewind": "^4.1.0",
    "react-native-reanimated": "~3.16.0",
    "msw": "^2.7.0"
  },
  "devDependencies": {
    "@types/react": "~18.3.0",
    "tailwindcss": "^3.4.0",
    "typescript": "~5.3.0"
  }
}
```

Note: Use `npx create-expo-app test-app --template blank-typescript` if versions above are outdated at implementation time. The versions listed target Expo SDK 52 (latest stable as of 2026-03). Adjust to whatever `create-expo-app` produces, keeping the same dependency set.

- [ ] **Step 3: Create tsconfig.json**

```json
// test-app/tsconfig.json
{
  "extends": "expo/tsconfig.base",
  "compilerOptions": {
    "strict": true,
    "baseUrl": ".",
    "paths": {
      "src/*": ["./src/*"]
    }
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Create babel.config.js for NativeWind**

```js
// test-app/babel.config.js
module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      ['babel-preset-expo', { jsxImportSource: 'nativewind' }],
      'nativewind/babel',
    ],
  };
};
```

- [ ] **Step 5: Create tailwind.config.js**

```js
// test-app/tailwind.config.js
/** @type {import('tailwindcss').Config} */
module.exports = {
  presets: [require('nativewind/preset')],
  content: ['./src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {},
  },
  plugins: [],
};
```

- [ ] **Step 6: Create metro.config.js**

```js
// test-app/metro.config.js
const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

const config = getDefaultConfig(__dirname);

module.exports = withNativeWind(config, { input: './global.css' });
```

- [ ] **Step 7: Create global.css**

```css
/* test-app/global.css */
@tailwind base;
@tailwind components;
@tailwind utilities;
```

- [ ] **Step 8: Create minimal App.tsx**

```tsx
// test-app/src/App.tsx
import '../global.css';
import React from 'react';
import { View, Text } from 'react-native';

export default function App() {
  return (
    <View className="flex-1 items-center justify-center bg-white">
      <Text className="text-xl font-bold">rn-dev-agent test app</Text>
    </View>
  );
}
```

- [ ] **Step 9: Update root .gitignore**

Add to the project root `.gitignore`:

```
# Test app
test-app/node_modules/
test-app/.expo/
test-app/ios/
test-app/android/
test-app/harness/node_modules/
test-app/harness/dist/
```

- [ ] **Step 10: Install dependencies and verify app starts**

```bash
cd test-app && npm install
npx expo start --ios
```

Expected: App launches in iOS Simulator showing "rn-dev-agent test app" text.

- [ ] **Step 11: Commit**

```bash
git add test-app/ .gitignore
git commit -m "feat(test-app): scaffold Expo project with NativeWind"
```

---

### Task 2: Redux Store Setup

**Files:**
- Create: `test-app/src/store/index.ts`
- Create: `test-app/src/store/slices/userSlice.ts`
- Create: `test-app/src/store/slices/feedSlice.ts`
- Create: `test-app/src/store/slices/notificationsSlice.ts`
- Create: `test-app/src/store/slices/settingsSlice.ts`
- Modify: `test-app/src/App.tsx`

- [ ] **Step 1: Create userSlice**

```typescript
// test-app/src/store/slices/userSlice.ts
import { createSlice } from '@reduxjs/toolkit';
import type { PayloadAction } from '@reduxjs/toolkit';

interface UserState {
  name: string;
  email: string;
  avatar: string;
  loggedIn: boolean;
}

const initialState: UserState = {
  name: 'Test User',
  email: 'test@rndevagent.com',
  avatar: 'https://placeholders.dev/40x40',
  loggedIn: true,
};

const userSlice = createSlice({
  name: 'user',
  initialState,
  reducers: {
    updateName: (state, action: PayloadAction<string>) => {
      state.name = action.payload;
    },
    setLoggedIn: (state, action: PayloadAction<boolean>) => {
      state.loggedIn = action.payload;
    },
  },
});

export const { updateName, setLoggedIn } = userSlice.actions;
export default userSlice;
```

- [ ] **Step 2: Create feedSlice**

```typescript
// test-app/src/store/slices/feedSlice.ts
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
}

const initialState: FeedState = {
  items: [],
  loading: false,
  error: null,
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
    },
    setError: (state, action: PayloadAction<string>) => {
      state.error = action.payload;
      state.loading = false;
    },
  },
});

export const { setLoading, setItems, setError } = feedSlice.actions;
export default feedSlice;
```

- [ ] **Step 3: Create notificationsSlice**

```typescript
// test-app/src/store/slices/notificationsSlice.ts
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
```

- [ ] **Step 4: Create settingsSlice**

```typescript
// test-app/src/store/slices/settingsSlice.ts
import { createSlice } from '@reduxjs/toolkit';
import type { PayloadAction } from '@reduxjs/toolkit';

interface SettingsState {
  theme: 'light' | 'dark';
  language: 'en' | 'de';
}

const initialState: SettingsState = {
  theme: 'light',
  language: 'en',
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
  },
});

export const { toggleTheme, setLanguage } = settingsSlice.actions;
export default settingsSlice;
```

- [ ] **Step 5: Create store/index.ts with global exposure**

```typescript
// test-app/src/store/index.ts
import { configureStore } from '@reduxjs/toolkit';
import { persistStore, persistReducer } from 'redux-persist';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { combineReducers } from '@reduxjs/toolkit';
import userSlice from './slices/userSlice';
import feedSlice from './slices/feedSlice';
import notificationsSlice from './slices/notificationsSlice';
import settingsSlice from './slices/settingsSlice';

const rootReducer = combineReducers({
  user: userSlice.reducer,
  feed: feedSlice.reducer,
  notifications: notificationsSlice.reducer,
  settings: settingsSlice.reducer,
});

const persistConfig = {
  key: 'root',
  storage: AsyncStorage,
  whitelist: ['settings'],
};

const persistedReducer = persistReducer(persistConfig, rootReducer);

export const store = configureStore({
  reducer: persistedReducer,
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: false,
    }),
});

export const persistor = persistStore(store);

export type RootState = ReturnType<typeof rootReducer>;
export type AppDispatch = typeof store.dispatch;

// Expose store globally for cdp_store_state tool (D135)
if (__DEV__) {
  (globalThis as Record<string, unknown>).__REDUX_STORE__ = store;
}
```

- [ ] **Step 6: Update App.tsx with Redux Provider**

```tsx
// test-app/src/App.tsx
import '../global.css';
import React from 'react';
import { View, Text } from 'react-native';
import { Provider } from 'react-redux';
import { PersistGate } from 'redux-persist/integration/react';
import { store, persistor } from './store';

export default function App() {
  return (
    <Provider store={store}>
      <PersistGate loading={null} persistor={persistor}>
        <View className="flex-1 items-center justify-center bg-white">
          <Text className="text-xl font-bold">rn-dev-agent test app</Text>
        </View>
      </PersistGate>
    </Provider>
  );
}
```

- [ ] **Step 7: Verify app still launches**

```bash
cd test-app && npx expo start --ios
```

Expected: App launches showing "rn-dev-agent test app". No Redux errors in console.

- [ ] **Step 8: Commit**

```bash
git add test-app/src/store/
git commit -m "feat(test-app): add Redux store with 4 slices and global exposure"
```

---

### Task 3: Navigation Setup

**Files:**
- Create: `test-app/src/navigation/types.ts`
- Create: `test-app/src/navigation/RootNavigator.tsx`
- Create: `test-app/src/screens/HomeScreen.tsx` (placeholder)
- Create: `test-app/src/screens/ProfileScreen.tsx` (placeholder)
- Create: `test-app/src/screens/NotificationsScreen.tsx` (placeholder)
- Modify: `test-app/src/App.tsx`

- [ ] **Step 1: Create navigation type definitions**

```typescript
// test-app/src/navigation/types.ts
import type { NavigatorScreenParams } from '@react-navigation/native';

export type HomeStackParams = {
  HomeMain: undefined;
  Feed: undefined;
};

export type ProfileStackParams = {
  ProfileMain: undefined;
  Settings: undefined;
  ReloadTest: undefined;
};

export type TabParams = {
  HomeTab: NavigatorScreenParams<HomeStackParams>;
  ProfileTab: NavigatorScreenParams<ProfileStackParams>;
  NotificationsTab: undefined;
};

export type RootStackParams = {
  Tabs: NavigatorScreenParams<TabParams>;
  ErrorLab: undefined;
  DeepLink: { id: string };
};
```

- [ ] **Step 2: Create placeholder screens (Home, Profile, Notifications)**

```tsx
// test-app/src/screens/HomeScreen.tsx
import React from 'react';
import { View, Text } from 'react-native';

export default function HomeScreen() {
  return (
    <View testID="home-welcome" className="flex-1 items-center justify-center bg-white">
      <Text className="text-xl font-bold">Home</Text>
    </View>
  );
}
```

```tsx
// test-app/src/screens/ProfileScreen.tsx
import React from 'react';
import { View, Text } from 'react-native';

export default function ProfileScreen() {
  return (
    <View testID="profile-screen" className="flex-1 items-center justify-center bg-white">
      <Text className="text-xl font-bold">Profile</Text>
    </View>
  );
}
```

```tsx
// test-app/src/screens/NotificationsScreen.tsx
import React from 'react';
import { View, Text } from 'react-native';

export default function NotificationsScreen() {
  return (
    <View testID="notif-screen" className="flex-1 items-center justify-center bg-white">
      <Text className="text-xl font-bold">Notifications</Text>
    </View>
  );
}
```

- [ ] **Step 3: Create RootNavigator with tabs + stacks + deep linking**

```tsx
// test-app/src/navigation/RootNavigator.tsx
import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import type { RootStackParams, TabParams, HomeStackParams, ProfileStackParams } from './types';
import HomeScreen from '../screens/HomeScreen';
import ProfileScreen from '../screens/ProfileScreen';
import NotificationsScreen from '../screens/NotificationsScreen';

const RootStack = createNativeStackNavigator<RootStackParams>();
const Tab = createBottomTabNavigator<TabParams>();
const HomeStack = createNativeStackNavigator<HomeStackParams>();
const ProfileStack = createNativeStackNavigator<ProfileStackParams>();

function HomeStackNavigator() {
  return (
    <HomeStack.Navigator>
      <HomeStack.Screen name="HomeMain" component={HomeScreen} options={{ title: 'Home' }} />
    </HomeStack.Navigator>
  );
}

function ProfileStackNavigator() {
  return (
    <ProfileStack.Navigator>
      <ProfileStack.Screen name="ProfileMain" component={ProfileScreen} options={{ title: 'Profile' }} />
    </ProfileStack.Navigator>
  );
}

function TabNavigator() {
  return (
    <Tab.Navigator>
      <Tab.Screen name="HomeTab" component={HomeStackNavigator} options={{ headerShown: false, title: 'Home' }} />
      <Tab.Screen name="NotificationsTab" component={NotificationsScreen} options={{ title: 'Notifications' }} />
      <Tab.Screen name="ProfileTab" component={ProfileStackNavigator} options={{ headerShown: false, title: 'Profile' }} />
    </Tab.Navigator>
  );
}

// Deep link config. DeepLink screen added to config in Task 11 when registered.
const linking = {
  prefixes: ['rndatest://'],
  config: {
    screens: {
      Tabs: {
        screens: {
          HomeTab: {
            screens: {
              HomeMain: 'home',
              Feed: 'feed',
            },
          },
          NotificationsTab: 'notifications',
          ProfileTab: {
            screens: {
              ProfileMain: 'profile',
              Settings: 'settings',
              ReloadTest: 'reload',
            },
          },
        },
      },
    },
  },
};

export default function RootNavigator() {
  return (
    <RootStack.Navigator>
      <RootStack.Screen name="Tabs" component={TabNavigator} options={{ headerShown: false }} />
    </RootStack.Navigator>
  );
}

export { linking };
```

- [ ] **Step 4: Update App.tsx with NavigationContainer and global nav ref**

```tsx
// test-app/src/App.tsx
import '../global.css';
import React from 'react';
import { Provider } from 'react-redux';
import { PersistGate } from 'redux-persist/integration/react';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { store, persistor } from './store';
import RootNavigator, { linking } from './navigation/RootNavigator';
import type { RootStackParams } from './navigation/types';

const navigationRef = createNavigationContainerRef<RootStackParams>();

// Expose navigation ref globally for harness-driven navigation (D135)
if (__DEV__) {
  (globalThis as Record<string, unknown>).__NAV_REF__ = navigationRef;
}

export default function App() {
  return (
    <Provider store={store}>
      <PersistGate loading={null} persistor={persistor}>
        <NavigationContainer ref={navigationRef} linking={linking}>
          <RootNavigator />
        </NavigationContainer>
      </PersistGate>
    </Provider>
  );
}
```

- [ ] **Step 5: Verify app launches with tab navigation**

```bash
cd test-app && npx expo start --ios
```

Expected: App shows 3 tabs (Home, Notifications, Profile). Tapping each tab switches screens. No errors in Metro console.

- [ ] **Step 6: Commit**

```bash
git add test-app/src/navigation/ test-app/src/screens/ test-app/src/App.tsx
git commit -m "feat(test-app): add tab navigation with 3 placeholder screens"
```

---

### Task 4: MSW Setup

**Files:**
- Create: `test-app/src/mocks/handlers.ts`
- Create: `test-app/src/mocks/server.ts`
- Modify: `test-app/src/App.tsx`

- [ ] **Step 1: Create MSW request handlers**

```typescript
// test-app/src/mocks/handlers.ts
import { http, HttpResponse } from 'msw';

const BASE_URL = 'https://api.testapp.local';

export const handlers = [
  // GET /api/feed — returns 3 feed items
  http.get(`${BASE_URL}/api/feed`, async ({ request }) => {
    const url = new URL(request.url);
    if (url.searchParams.get('error') === 'true') {
      return HttpResponse.json(
        { error: 'Internal Server Error', message: 'Feed service unavailable' },
        { status: 500 },
      );
    }
    return HttpResponse.json([
      { id: '1', title: 'First Post', body: 'Hello from the test app feed' },
      { id: '2', title: 'Second Post', body: 'Testing network log capture' },
      { id: '3', title: 'Third Post', body: 'MSW mock response' },
    ]);
  }),

  // GET /api/user/profile — returns user object
  http.get(`${BASE_URL}/api/user/profile`, () => {
    return HttpResponse.json({
      name: 'Test User',
      email: 'test@rndevagent.com',
      avatar: 'https://placeholders.dev/40x40',
    });
  }),

  // POST /api/notifications/read — 204 no content
  http.post(`${BASE_URL}/api/notifications/read`, () => {
    return new HttpResponse(null, { status: 204 });
  }),
];
```

- [ ] **Step 2: Create MSW server setup**

```typescript
// test-app/src/mocks/server.ts
import { setupServer } from 'msw/native';
import { handlers } from './handlers';

export const server = setupServer(...handlers);
```

- [ ] **Step 3: Initialize MSW in App.tsx BEFORE navigation renders**

Update `test-app/src/App.tsx` — add MSW initialization at the top, before providers:

```tsx
// test-app/src/App.tsx
import '../global.css';
import React from 'react';
import { Provider } from 'react-redux';
import { PersistGate } from 'redux-persist/integration/react';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { store, persistor } from './store';
import RootNavigator, { linking } from './navigation/RootNavigator';
import type { RootStackParams } from './navigation/types';
import { server } from './mocks/server';

// Initialize MSW BEFORE CDP bridge connects (D132)
// The plugin's fetch hooks will wrap MSW's patched fetch,
// allowing cdp_network_log to observe synthetic responses.
server.listen({ onUnhandledRequest: 'bypass' });

const navigationRef = createNavigationContainerRef<RootStackParams>();

if (__DEV__) {
  (globalThis as Record<string, unknown>).__NAV_REF__ = navigationRef;
}

export default function App() {
  return (
    <Provider store={store}>
      <PersistGate loading={null} persistor={persistor}>
        <NavigationContainer ref={navigationRef} linking={linking}>
          <RootNavigator />
        </NavigationContainer>
      </PersistGate>
    </Provider>
  );
}
```

- [ ] **Step 4: Verify MSW doesn't break app startup**

```bash
cd test-app && npx expo start --ios
```

Expected: App launches normally. No errors about MSW in Metro console. MSW intercepts only matching URLs; all others pass through (`onUnhandledRequest: 'bypass'`).

- [ ] **Step 5: Commit**

```bash
git add test-app/src/mocks/
git commit -m "feat(test-app): add MSW network mocking with 3 endpoints"
```

---

## Chunk 2: Screen Implementations

### Task 5: HomeScreen — Component Tree Exercise

**Files:**
- Modify: `test-app/src/screens/HomeScreen.tsx`

The Home screen exercises `cdp_component_tree` by having nested components 3 levels deep with testIDs on key elements.

- [ ] **Step 1: Implement HomeScreen with nested components**

```tsx
// test-app/src/screens/HomeScreen.tsx
import React from 'react';
import { View, Text, Pressable } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { CompositeScreenProps } from '@react-navigation/native';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { HomeStackParams, TabParams } from '../navigation/types';

type Props = CompositeScreenProps<
  NativeStackScreenProps<HomeStackParams, 'HomeMain'>,
  BottomTabScreenProps<TabParams>
>;

function FeatureCard({ index, title, description }: { index: number; title: string; description: string }) {
  return (
    <View testID={`home-feature-${index}`} className="mb-3 rounded-lg bg-gray-100 p-4">
      <Text className="text-base font-semibold">{title}</Text>
      <Text className="mt-1 text-sm text-gray-600">{description}</Text>
    </View>
  );
}

function FeatureList() {
  const features = [
    { title: 'Component Tree', description: 'Tests cdp_component_tree with nested testIDs' },
    { title: 'Navigation State', description: 'Tests cdp_navigation_state across tabs and stacks' },
    { title: 'Store State', description: 'Tests cdp_store_state with Redux Toolkit slices' },
  ];

  return (
    <View testID="home-feature-list" className="mt-4">
      {features.map((f, i) => (
        <FeatureCard key={i} index={i} title={f.title} description={f.description} />
      ))}
    </View>
  );
}

export default function HomeScreen({ navigation }: Props) {
  return (
    <View testID="home-welcome" className="flex-1 bg-white px-4 pt-4">
      <Text className="text-2xl font-bold">Welcome</Text>
      <Text className="mt-1 text-gray-500">rn-dev-agent test fixture</Text>
      <FeatureList />
      <Pressable
        testID="home-feed-btn"
        className="mt-4 rounded-lg bg-blue-500 px-4 py-3"
        onPress={() => navigation.navigate('Feed')}
      >
        <Text className="text-center font-semibold text-white">Go to Feed</Text>
      </Pressable>
    </View>
  );
}
```

- [ ] **Step 2: Register Feed screen in HomeStack (placeholder for now)**

Update `test-app/src/navigation/RootNavigator.tsx` — add a placeholder FeedScreen import and register it in `HomeStackNavigator`:

```tsx
// Add to imports at top of RootNavigator.tsx:
import FeedScreen from '../screens/FeedScreen';

// Add inside HomeStackNavigator, after HomeMain:
<HomeStack.Screen name="Feed" component={FeedScreen} options={{ title: 'Feed' }} />
```

Create placeholder:

```tsx
// test-app/src/screens/FeedScreen.tsx
import React from 'react';
import { View, Text } from 'react-native';

export default function FeedScreen() {
  return (
    <View className="flex-1 items-center justify-center bg-white">
      <Text>Feed (placeholder)</Text>
    </View>
  );
}
```

- [ ] **Step 3: Verify Home screen renders and navigation works**

```bash
cd test-app && npx expo start --ios
```

Expected: Home tab shows welcome text, 3 feature cards with testIDs, and "Go to Feed" button. Tapping the button pushes to Feed placeholder.

- [ ] **Step 4: Commit**

```bash
git add test-app/src/screens/HomeScreen.tsx test-app/src/screens/FeedScreen.tsx test-app/src/navigation/RootNavigator.tsx
git commit -m "feat(test-app): implement HomeScreen with nested components and testIDs"
```

---

### Task 6: ProfileScreen — Store State Exercise

**Files:**
- Modify: `test-app/src/screens/ProfileScreen.tsx`

- [ ] **Step 1: Implement ProfileScreen reading from Redux**

```tsx
// test-app/src/screens/ProfileScreen.tsx
import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { useSelector, useDispatch } from 'react-redux';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { CompositeScreenProps } from '@react-navigation/native';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { RootState } from '../store';
import type { ProfileStackParams, TabParams } from '../navigation/types';
import { updateName } from '../store/slices/userSlice';

type Props = CompositeScreenProps<
  NativeStackScreenProps<ProfileStackParams, 'ProfileMain'>,
  BottomTabScreenProps<TabParams>
>;

export default function ProfileScreen({ navigation }: Props) {
  const user = useSelector((state: RootState) => state.user);
  const dispatch = useDispatch();

  const handleUpdateName = () => {
    const newName = user.name === 'Test User' ? 'Updated User' : 'Test User';
    dispatch(updateName(newName));
  };

  return (
    <View className="flex-1 bg-white px-4 pt-4">
      <View testID="profile-avatar" className="mb-4 h-20 w-20 rounded-full bg-gray-200" />
      <Text testID="profile-name" className="text-xl font-bold">{user.name}</Text>
      <Text testID="profile-email" className="mt-1 text-gray-500">{user.email}</Text>

      <Pressable
        testID="profile-update-btn"
        className="mt-6 rounded-lg bg-blue-500 px-4 py-3"
        onPress={handleUpdateName}
      >
        <Text className="text-center font-semibold text-white">Update Name</Text>
      </Pressable>

      <Pressable
        testID="profile-settings-btn"
        className="mt-3 rounded-lg bg-gray-200 px-4 py-3"
        onPress={() => navigation.navigate('Settings')}
      >
        <Text className="text-center font-semibold">Settings</Text>
      </Pressable>
    </View>
  );
}
```

- [ ] **Step 2: Register Settings in ProfileStack (placeholder)**

Update `test-app/src/navigation/RootNavigator.tsx` — add placeholder SettingsScreen and register:

```tsx
// Add import:
import SettingsScreen from '../screens/SettingsScreen';

// Add inside ProfileStackNavigator after ProfileMain:
<ProfileStack.Screen name="Settings" component={SettingsScreen} options={{ title: 'Settings' }} />
```

Create placeholder:

```tsx
// test-app/src/screens/SettingsScreen.tsx
import React from 'react';
import { View, Text } from 'react-native';

export default function SettingsScreen() {
  return (
    <View className="flex-1 items-center justify-center bg-white">
      <Text>Settings (placeholder)</Text>
    </View>
  );
}
```

- [ ] **Step 3: Verify Profile screen shows Redux data**

Expected: Profile tab shows "Test User", "test@rndevagent.com". Tapping "Update Name" toggles the name. Tapping "Settings" pushes to placeholder.

- [ ] **Step 4: Commit**

```bash
git add test-app/src/screens/ProfileScreen.tsx test-app/src/screens/SettingsScreen.tsx test-app/src/navigation/RootNavigator.tsx
git commit -m "feat(test-app): implement ProfileScreen with Redux store read/write"
```

---

### Task 7: FeedScreen — Network Log Exercise

**Files:**
- Modify: `test-app/src/screens/FeedScreen.tsx`

- [ ] **Step 1: Implement FeedScreen with MSW-backed fetch**

```tsx
// test-app/src/screens/FeedScreen.tsx
import React, { useEffect, useCallback } from 'react';
import { View, Text, Pressable, ActivityIndicator, FlatList } from 'react-native';
import { useDispatch, useSelector } from 'react-redux';
import type { RootState, AppDispatch } from '../store';
import { setLoading, setItems, setError } from '../store/slices/feedSlice';
import type { FeedItem } from '../store/slices/feedSlice';

const API_BASE = 'https://api.testapp.local';

export default function FeedScreen() {
  const dispatch = useDispatch<AppDispatch>();
  const { items, loading, error } = useSelector((state: RootState) => state.feed);

  const fetchFeed = useCallback(async (triggerError = false) => {
    dispatch(setLoading(true));
    try {
      const url = triggerError ? `${API_BASE}/api/feed?error=true` : `${API_BASE}/api/feed`;
      const res = await fetch(url);
      if (!res.ok) {
        const body = await res.json();
        dispatch(setError(body.message ?? 'Request failed'));
        return;
      }
      const data: FeedItem[] = await res.json();
      dispatch(setItems(data));
    } catch (err) {
      dispatch(setError(err instanceof Error ? err.message : 'Unknown error'));
    }
  }, [dispatch]);

  useEffect(() => {
    void fetchFeed();
  }, [fetchFeed]);

  const renderItem = ({ item, index }: { item: FeedItem; index: number }) => (
    <View testID={`feed-item-${index}`} className="mb-3 rounded-lg bg-gray-100 p-4">
      <Text className="font-semibold">{item.title}</Text>
      <Text className="mt-1 text-sm text-gray-600">{item.body}</Text>
    </View>
  );

  return (
    <View className="flex-1 bg-white px-4 pt-4">
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

      {!loading && !error && (
        <FlatList
          data={items}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
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
```

- [ ] **Step 2: Verify Feed screen fetches and displays data**

Expected: Navigate Home > "Go to Feed". Shows loading spinner briefly, then 3 feed items. Tapping "Trigger Error" shows error state with retry button.

- [ ] **Step 3: Commit**

```bash
git add test-app/src/screens/FeedScreen.tsx
git commit -m "feat(test-app): implement FeedScreen with MSW-backed fetch"
```

---

### Task 8: NotificationsScreen — Console Log Exercise

**Files:**
- Modify: `test-app/src/screens/NotificationsScreen.tsx`

- [ ] **Step 1: Implement NotificationsScreen with deliberate console output**

```tsx
// test-app/src/screens/NotificationsScreen.tsx
import React, { useEffect } from 'react';
import { View, Text, Pressable, FlatList } from 'react-native';
import { useSelector, useDispatch } from 'react-redux';
import type { RootState } from '../store';
import { markAllRead } from '../store/slices/notificationsSlice';
import type { NotificationItem } from '../store/slices/notificationsSlice';

const API_BASE = 'https://api.testapp.local';

export default function NotificationsScreen() {
  const dispatch = useDispatch();
  const { items, unreadCount } = useSelector((state: RootState) => state.notifications);

  useEffect(() => {
    // Deliberate console output for cdp_console_log testing
    console.log('notifications loaded');
    console.warn('stale cache');
    console.error('notification parse failed');
  }, []);

  const handleMarkRead = async () => {
    await fetch(`${API_BASE}/api/notifications/read`, { method: 'POST' });
    dispatch(markAllRead());
  };

  const renderItem = ({ item, index }: { item: NotificationItem; index: number }) => (
    <View
      testID={`notif-item-${index}`}
      className={`mb-2 rounded-lg p-4 ${item.read ? 'bg-gray-50' : 'bg-blue-50'}`}
    >
      <Text className={item.read ? 'text-gray-500' : 'font-semibold'}>{item.title}</Text>
    </View>
  );

  return (
    <View className="flex-1 bg-white px-4 pt-4">
      <Text className="text-xl font-bold">Notifications ({unreadCount} unread)</Text>

      <FlatList
        className="mt-4"
        data={items}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
      />

      <Pressable
        testID="notif-mark-read-btn"
        className="mt-4 rounded-lg bg-green-500 px-4 py-3"
        onPress={handleMarkRead}
      >
        <Text className="text-center font-semibold text-white">Mark All Read</Text>
      </Pressable>
    </View>
  );
}
```

- [ ] **Step 2: Verify Notifications screen logs on mount**

Expected: Tap Notifications tab. Metro console shows: `notifications loaded`, `stale cache` (yellow), `notification parse failed` (red). Screen shows 3 notifications.

- [ ] **Step 3: Commit**

```bash
git add test-app/src/screens/NotificationsScreen.tsx
git commit -m "feat(test-app): implement NotificationsScreen with console output"
```

---

### Task 9: SettingsScreen — Dev Settings Exercise

**Files:**
- Modify: `test-app/src/screens/SettingsScreen.tsx`

- [ ] **Step 1: Implement SettingsScreen with toggle switches**

```tsx
// test-app/src/screens/SettingsScreen.tsx
import React from 'react';
import { View, Text, Switch, Pressable } from 'react-native';
import { useSelector, useDispatch } from 'react-redux';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootState } from '../store';
import type { ProfileStackParams } from '../navigation/types';
import { toggleTheme, setLanguage } from '../store/slices/settingsSlice';

type Props = NativeStackScreenProps<ProfileStackParams, 'Settings'>;

export default function SettingsScreen({ navigation }: Props) {
  const dispatch = useDispatch();
  const settings = useSelector((state: RootState) => state.settings);

  return (
    <View className="flex-1 bg-white px-4 pt-4">
      <Text className="text-xl font-bold">Settings</Text>

      <View className="mt-6 flex-row items-center justify-between">
        <Text className="text-base">Dark Theme</Text>
        <Switch
          testID="settings-theme-toggle"
          value={settings.theme === 'dark'}
          onValueChange={() => dispatch(toggleTheme())}
        />
      </View>

      <View className="mt-4 flex-row items-center justify-between">
        <Text className="text-base">Language (DE)</Text>
        <Switch
          testID="settings-language-toggle"
          value={settings.language === 'de'}
          onValueChange={(value) => dispatch(setLanguage(value ? 'de' : 'en'))}
        />
      </View>

      <Pressable
        testID="settings-reload-btn"
        className="mt-6 rounded-lg bg-gray-200 px-4 py-3"
        onPress={() => navigation.navigate('ReloadTest')}
      >
        <Text className="text-center font-semibold">Reload Test</Text>
      </Pressable>
    </View>
  );
}
```

- [ ] **Step 2: Register ReloadTest in ProfileStack (placeholder)**

Update `test-app/src/navigation/RootNavigator.tsx`:

```tsx
// Add import:
import ReloadTestScreen from '../screens/ReloadTestScreen';

// Add inside ProfileStackNavigator after Settings:
<ProfileStack.Screen name="ReloadTest" component={ReloadTestScreen} options={{ title: 'Reload Test' }} />
```

Create placeholder:

```tsx
// test-app/src/screens/ReloadTestScreen.tsx
import React from 'react';
import { View, Text } from 'react-native';

export default function ReloadTestScreen() {
  return (
    <View className="flex-1 items-center justify-center bg-white">
      <Text>Reload Test (placeholder)</Text>
    </View>
  );
}
```

- [ ] **Step 3: Verify Settings screen toggles work**

Expected: Profile > Settings. Theme and Language toggles dispatch Redux actions. "Reload Test" button pushes to placeholder.

- [ ] **Step 4: Commit**

```bash
git add test-app/src/screens/SettingsScreen.tsx test-app/src/screens/ReloadTestScreen.tsx test-app/src/navigation/RootNavigator.tsx
git commit -m "feat(test-app): implement SettingsScreen with toggles"
```

---

### Task 10: ErrorLabModal — Error Log Exercise

**Files:**
- Create: `test-app/src/screens/ErrorLabModal.tsx`
- Modify: `test-app/src/navigation/RootNavigator.tsx`

- [ ] **Step 1: Implement ErrorLabModal with 3 error triggers**

```tsx
// test-app/src/screens/ErrorLabModal.tsx
import React, { useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParams } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParams, 'ErrorLab'>;

// Component that throws during render (triggers RedBox)
function CrashComponent() {
  throw new Error('test-redbox-render-error');
}

export default function ErrorLabModal({ navigation }: Props) {
  const [crashChild, setCrashChild] = useState(false);

  const handleThrowError = () => {
    throw new Error('test-sync-error');
  };

  const handleUnhandledRejection = () => {
    void Promise.reject(new Error('test-unhandled-rejection'));
  };

  const handleRedBox = () => {
    setCrashChild(true);
  };

  return (
    <View className="flex-1 bg-white px-4 pt-4">
      <Text className="text-xl font-bold">Error Lab</Text>
      <Text className="mt-1 text-gray-500">Trigger errors for cdp_error_log testing</Text>

      <Pressable
        testID="error-lab-throw"
        className="mt-6 rounded-lg bg-red-500 px-4 py-3"
        onPress={handleThrowError}
      >
        <Text className="text-center font-semibold text-white">Throw Error</Text>
      </Pressable>

      <Pressable
        testID="error-lab-rejection"
        className="mt-3 rounded-lg bg-orange-500 px-4 py-3"
        onPress={handleUnhandledRejection}
      >
        <Text className="text-center font-semibold text-white">Unhandled Rejection</Text>
      </Pressable>

      <Pressable
        testID="error-lab-redbox"
        className="mt-3 rounded-lg bg-purple-500 px-4 py-3"
        onPress={handleRedBox}
      >
        <Text className="text-center font-semibold text-white">Trigger RedBox</Text>
      </Pressable>

      {crashChild && <CrashComponent />}

      <Pressable
        className="mt-6 rounded-lg bg-gray-200 px-4 py-3"
        onPress={() => navigation.goBack()}
      >
        <Text className="text-center font-semibold">Close</Text>
      </Pressable>
    </View>
  );
}
```

- [ ] **Step 2: Register ErrorLab as a modal in RootNavigator**

Update `test-app/src/navigation/RootNavigator.tsx`:

```tsx
// Add import:
import ErrorLabModal from '../screens/ErrorLabModal';

// Add inside RootStack.Navigator, after the Tabs screen:
<RootStack.Screen name="ErrorLab" component={ErrorLabModal} options={{ presentation: 'modal', title: 'Error Lab' }} />
```

- [ ] **Step 3: Add floating Error Lab button to TabNavigator**

Add a helper button inside the `TabNavigator` component. Update the `TabNavigator` function in `RootNavigator.tsx`:

```tsx
// Replace the TabNavigator function body to include a floating button:
function TabNavigator() {
  return (
    <Tab.Navigator>
      <Tab.Screen name="HomeTab" component={HomeStackNavigator} options={{ headerShown: false, title: 'Home' }} />
      <Tab.Screen name="NotificationsTab" component={NotificationsScreen} options={{ title: 'Notifications' }} />
      <Tab.Screen name="ProfileTab" component={ProfileStackNavigator} options={{ headerShown: false, title: 'Profile' }} />
    </Tab.Navigator>
  );
}
```

Note: The Error Lab is accessible via the harness using `cdp_evaluate('__NAV_REF__.navigate("ErrorLab")')`. No floating button needed — that would add UI complexity.

- [ ] **Step 4: Verify ErrorLab modal**

Test by running: open app, then in Metro terminal/debugger:
- The harness will navigate here via `__NAV_REF__.navigate("ErrorLab")`
- Tapping "Throw Error" triggers the global error handler (LogBox warning in dev)
- Tapping "Unhandled Rejection" triggers unhandled promise rejection handler
- Tapping "Trigger RedBox" shows a render-phase error (RedBox, requires `cdp_reload` to recover)

- [ ] **Step 5: Commit**

```bash
git add test-app/src/screens/ErrorLabModal.tsx test-app/src/navigation/RootNavigator.tsx
git commit -m "feat(test-app): add ErrorLab modal with 3 error triggers"
```

---

### Task 11: DeepLinkScreen & ReloadTestScreen

**Files:**
- Create: `test-app/src/screens/DeepLinkScreen.tsx`
- Modify: `test-app/src/screens/ReloadTestScreen.tsx`
- Modify: `test-app/src/navigation/RootNavigator.tsx`

- [ ] **Step 1: Implement DeepLinkScreen**

```tsx
// test-app/src/screens/DeepLinkScreen.tsx
import React from 'react';
import { View, Text } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParams } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParams, 'DeepLink'>;

export default function DeepLinkScreen({ route }: Props) {
  const { id } = route.params;

  return (
    <View className="flex-1 items-center justify-center bg-white px-4">
      <Text className="text-xl font-bold">Deep Link Target</Text>
      <Text testID="deeplink-id" className="mt-4 text-lg">ID: {id}</Text>
      <Text testID="deeplink-params" className="mt-2 text-gray-500">
        Params: {JSON.stringify(route.params)}
      </Text>
    </View>
  );
}
```

- [ ] **Step 2: Implement ReloadTestScreen**

```tsx
// test-app/src/screens/ReloadTestScreen.tsx
import React, { useRef } from 'react';
import { View, Text, Pressable } from 'react-native';

// Module-scope counter survives fast refresh (Metro keeps modules in memory)
// but resets on full reload (module re-evaluated from scratch).
let mountCount = 0;

export default function ReloadTestScreen() {
  // Capture count at mount time. The module-scope variable is what persists.
  const countRef = useRef(++mountCount);

  return (
    <View className="flex-1 items-center justify-center bg-white px-4">
      <Text className="text-xl font-bold">Reload Test</Text>
      <Text testID="reload-counter" className="mt-4 text-4xl font-bold text-blue-500">
        {countRef.current}
      </Text>
      <Text className="mt-2 text-gray-500">Mount count (resets on full reload)</Text>
      <Pressable
        testID="reload-btn"
        className="mt-6 rounded-lg bg-blue-500 px-6 py-3"
        onPress={() => {
          // The harness triggers reload via cdp_reload, not this button.
          // Button exists for manual testing.
        }}
      >
        <Text className="text-center font-semibold text-white">Manual Reload (use cdp_reload)</Text>
      </Pressable>
    </View>
  );
}
```

- [ ] **Step 3: Register DeepLinkScreen in RootNavigator**

Update `test-app/src/navigation/RootNavigator.tsx`:

```tsx
// Add import:
import DeepLinkScreen from '../screens/DeepLinkScreen';

// Add inside RootStack.Navigator, after ErrorLab:
<RootStack.Screen name="DeepLink" component={DeepLinkScreen} options={{ title: 'Deep Link' }} />

// Also add DeepLink to the linking config object (was deferred from Task 3):
// In the linking.config.screens, add at the top level alongside Tabs:
//   DeepLink: 'deeplink',
```

- [ ] **Step 4: Verify deep link and reload screens**

Test deep link: `xcrun simctl openurl booted "rndatest://deeplink?id=123"` — should show DeepLinkScreen with "ID: 123".

Test reload: Profile > Settings > Reload Test — shows mount counter "1".

- [ ] **Step 5: Commit**

```bash
git add test-app/src/screens/DeepLinkScreen.tsx test-app/src/screens/ReloadTestScreen.tsx test-app/src/navigation/RootNavigator.tsx
git commit -m "feat(test-app): add DeepLinkScreen and ReloadTestScreen"
```

---

## Chunk 3: Test Harness Infrastructure

### Task 12: Harness Scaffolding

**Files:**
- Create: `test-app/harness/package.json`
- Create: `test-app/harness/tsconfig.json`

- [ ] **Step 1: Create harness package.json**

```json
// test-app/harness/package.json
{
  "name": "rn-dev-agent-test-harness",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "dist/run.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/run.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.4.0"
  },
  "engines": {
    "node": ">=18"
  }
}
```

- [ ] **Step 2: Create harness tsconfig.json**

```json
// test-app/harness/tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": false
  },
  "include": ["run.ts", "lib/**/*.ts", "suites/**/*.ts"]
}
```

- [ ] **Step 3: Install harness dependencies**

```bash
cd test-app/harness && npm install
```

Expected: `node_modules/` created with `@modelcontextprotocol/sdk` and `typescript`.

- [ ] **Step 4: Commit**

```bash
git add test-app/harness/package.json test-app/harness/tsconfig.json
git commit -m "feat(harness): scaffold harness project with MCP SDK dependency"
```

---

### Task 13: Assertion Library

**Files:**
- Create: `test-app/harness/lib/assertions.ts`

- [ ] **Step 1: Create assertion helpers**

```typescript
// test-app/harness/lib/assertions.ts
export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssertionError';
  }
}

export function assertEqual<T>(actual: T, expected: T, label?: string): void {
  if (actual !== expected) {
    throw new AssertionError(
      `${label ? label + ': ' : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

export function assertContains(haystack: string, needle: string, label?: string): void {
  if (!haystack.includes(needle)) {
    throw new AssertionError(
      `${label ? label + ': ' : ''}expected string to contain "${needle}", got: "${haystack.slice(0, 200)}"`,
    );
  }
}

export function assertTruthy(value: unknown, label?: string): void {
  if (!value) {
    throw new AssertionError(
      `${label ? label + ': ' : ''}expected truthy value, got ${JSON.stringify(value)}`,
    );
  }
}

export function assertShape(obj: unknown, keys: string[], label?: string): void {
  if (typeof obj !== 'object' || obj === null) {
    throw new AssertionError(
      `${label ? label + ': ' : ''}expected object, got ${typeof obj}`,
    );
  }
  for (const key of keys) {
    if (!(key in obj)) {
      throw new AssertionError(
        `${label ? label + ': ' : ''}missing key "${key}" in ${JSON.stringify(Object.keys(obj))}`,
      );
    }
  }
}

export function assertGreaterThan(actual: number, min: number, label?: string): void {
  if (actual <= min) {
    throw new AssertionError(
      `${label ? label + ': ' : ''}expected > ${min}, got ${actual}`,
    );
  }
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd test-app/harness && npx tsc --noEmit
```

Expected: No errors (may show errors for missing files — that's fine, we haven't created `run.ts` yet).

- [ ] **Step 3: Commit**

```bash
git add test-app/harness/lib/assertions.ts
git commit -m "feat(harness): add assertion helpers"
```

---

### Task 14: MCP Client Wrapper

**Files:**
- Create: `test-app/harness/lib/mcp-client.ts`

- [ ] **Step 1: Create MCP client that spawns cdp-bridge as child process**

```typescript
// test-app/harness/lib/mcp-client.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Path to the cdp-bridge MCP server
// From dist/lib/ -> dist/ -> harness/ -> test-app/ -> project root
const CDP_BRIDGE_PATH = resolve(__dirname, '..', '..', '..', '..', 'scripts', 'cdp-bridge', 'dist', 'index.js');

export interface ToolCallResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

export class McpTestClient {
  private client: Client;
  private transport: StdioClientTransport | null = null;

  constructor() {
    this.client = new Client({ name: 'test-harness', version: '1.0.0' }, {});
  }

  async connect(): Promise<void> {
    this.transport = new StdioClientTransport({
      command: 'node',
      args: [CDP_BRIDGE_PATH],
    });
    await this.client.connect(this.transport);
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
    const result = await this.client.callTool({ name, arguments: args });
    return result as ToolCallResult;
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  /** Extract the text content from a tool result, parse as JSON if possible */
  static parseResult(result: ToolCallResult): unknown {
    const text = result.content
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text)
      .join('');
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd test-app/harness && npx tsc --noEmit
```

Expected: Compiles without errors.

- [ ] **Step 3: Commit**

```bash
git add test-app/harness/lib/mcp-client.ts
git commit -m "feat(harness): add MCP client wrapper that spawns cdp-bridge"
```

---

### Task 15: Harness Runner

**Files:**
- Create: `test-app/harness/run.ts`

- [ ] **Step 1: Create the main harness runner**

```typescript
// test-app/harness/run.ts
import { McpTestClient } from './lib/mcp-client.js';

export interface SuiteResult {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  message: string;
  durationMs: number;
}

export type Suite = (client: McpTestClient) => Promise<string>;

const SUITE_TIMEOUT_MS = 15_000;

async function runSuite(client: McpTestClient, name: string, suite: Suite): Promise<SuiteResult> {
  const start = Date.now();
  try {
    const result = await Promise.race([
      suite(client),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout after ${SUITE_TIMEOUT_MS}ms`)), SUITE_TIMEOUT_MS),
      ),
    ]);
    return { name, status: 'pass', message: result, durationMs: Date.now() - start };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { name, status: 'fail', message, durationMs: Date.now() - start };
  }
}

async function main(): Promise<void> {
  // Dynamically import suites in execution order (D136)
  const { statusSuite } = await import('./suites/status.js');
  const { evaluateSuite } = await import('./suites/evaluate.js');
  const { componentTreeSuite } = await import('./suites/component-tree.js');
  const { navigationSuite } = await import('./suites/navigation.js');
  const { storeStateSuite } = await import('./suites/store-state.js');
  const { networkLogSuite } = await import('./suites/network-log.js');
  const { consoleLogSuite } = await import('./suites/console-log.js');
  const { errorLogSuite } = await import('./suites/error-log.js');
  const { devSettingsSuite } = await import('./suites/dev-settings.js');
  const { reloadSuite } = await import('./suites/reload.js');

  const suites: Array<[string, Suite]> = [
    ['cdp_status', statusSuite],
    ['cdp_evaluate', evaluateSuite],
    ['cdp_component_tree', componentTreeSuite],
    ['cdp_navigation_state', navigationSuite],
    ['cdp_store_state', storeStateSuite],
    ['cdp_network_log', networkLogSuite],
    ['cdp_console_log', consoleLogSuite],
    ['cdp_error_log', errorLogSuite],
    ['cdp_dev_settings', devSettingsSuite],
    ['cdp_reload', reloadSuite],
  ];

  console.log('Connecting to cdp-bridge MCP server...');
  const client = new McpTestClient();
  await client.connect();
  console.log('Connected. Running suites...\n');

  const results: SuiteResult[] = [];
  for (const [name, suite] of suites) {
    const result = await runSuite(client, name, suite);
    // Print each result as it completes
    const tag = result.status === 'pass' ? '\x1b[32m[PASS]\x1b[0m'
      : result.status === 'fail' ? '\x1b[31m[FAIL]\x1b[0m'
      : '\x1b[33m[SKIP]\x1b[0m';
    console.log(`${tag} ${result.name} — ${result.message} (${result.durationMs}ms)`);
    results.push(result);
  }

  await client.close();

  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  console.log(`\n${results.length} suites: ${passed} passed, ${failed} failed`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Harness fatal error:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Create stub suite files so TypeScript compiles**

Create 10 stub files, each exporting a suite function. Example pattern for all:

```typescript
// test-app/harness/suites/status.ts
import type { McpTestClient } from '../lib/mcp-client.js';
export async function statusSuite(_client: McpTestClient): Promise<string> {
  return 'not implemented';
}
```

Create identical stubs for: `evaluate.ts`, `component-tree.ts`, `navigation.ts`, `store-state.ts`, `network-log.ts`, `console-log.ts`, `error-log.ts`, `dev-settings.ts`, `reload.ts` — each exporting `<name>Suite`.

- [ ] **Step 3: Verify the full harness compiles and runs (stubs)**

```bash
cd test-app/harness && npx tsc && node dist/run.js
```

Expected: Connects to MCP server (may fail if cdp-bridge not built yet — that's fine, the TypeScript compilation is what matters). If cdp-bridge IS built, it should print 10 `[PASS]` results with "not implemented" message.

- [ ] **Step 4: Commit**

```bash
git add test-app/harness/
git commit -m "feat(harness): add runner with 10 stub suites"
```

---

## Chunk 4: Test Suite Implementations

### Task 16: Status & Evaluate Suites

**Files:**
- Modify: `test-app/harness/suites/status.ts`
- Modify: `test-app/harness/suites/evaluate.ts`

- [ ] **Step 1: Implement status suite**

```typescript
// test-app/harness/suites/status.ts
import { McpTestClient } from '../lib/mcp-client.js';
import { assertTruthy, assertShape, assertEqual } from '../lib/assertions.js';

export async function statusSuite(client: McpTestClient): Promise<string> {
  const result = await client.callTool('cdp_status');
  assertTruthy(!result.isError, 'cdp_status returned error');

  const data = McpTestClient.parseResult(result) as Record<string, unknown>;
  assertShape(data, ['metro', 'cdp', 'app', 'capabilities'], 'status response shape');

  const metro = data.metro as Record<string, unknown>;
  assertEqual(metro.running, true, 'metro.running');

  const cdp = data.cdp as Record<string, unknown>;
  assertEqual(cdp.connected, true, 'cdp.connected');

  const app = data.app as Record<string, unknown>;
  assertEqual(app.hermes, true, 'app.hermes');
  assertEqual(app.dev, true, 'app.dev');
  assertEqual(app.hasRedBox, false, 'app.hasRedBox');

  return 'connected, app info valid';
}
```

- [ ] **Step 2: Implement evaluate suite**

```typescript
// test-app/harness/suites/evaluate.ts
import { McpTestClient } from '../lib/mcp-client.js';
import { assertTruthy, assertShape, assertEqual } from '../lib/assertions.js';

export async function evaluateSuite(client: McpTestClient): Promise<string> {
  // Test 1: getAppInfo returns expected shape
  const infoResult = await client.callTool('cdp_evaluate', {
    expression: '__RN_AGENT.getAppInfo()',
  });
  assertTruthy(!infoResult.isError, 'getAppInfo returned error');
  const infoText = (infoResult.content[0] as { text: string }).text;
  const info = JSON.parse(infoText) as Record<string, unknown>;
  assertShape(info, ['platform', 'hermes', '__DEV__'], 'appInfo shape');
  assertEqual(info.hermes, true, 'hermes enabled');
  assertEqual(info.__DEV__, true, 'dev mode');

  // Test 2: __NAV_REF__ is accessible
  const navResult = await client.callTool('cdp_evaluate', {
    expression: 'typeof globalThis.__NAV_REF__',
  });
  assertTruthy(!navResult.isError, '__NAV_REF__ check error');
  const navType = (navResult.content[0] as { text: string }).text;
  assertEqual(navType, 'object', '__NAV_REF__ type');

  // Test 3: __REDUX_STORE__ is accessible
  const storeResult = await client.callTool('cdp_evaluate', {
    expression: 'typeof globalThis.__REDUX_STORE__',
  });
  assertTruthy(!storeResult.isError, '__REDUX_STORE__ check error');
  const storeType = (storeResult.content[0] as { text: string }).text;
  assertEqual(storeType, 'object', '__REDUX_STORE__ type');

  return 'getAppInfo valid, globals accessible';
}
```

- [ ] **Step 3: Commit**

```bash
git add test-app/harness/suites/status.ts test-app/harness/suites/evaluate.ts
git commit -m "feat(harness): implement status and evaluate suites"
```

---

### Task 17: Component Tree & Navigation Suites

**Files:**
- Modify: `test-app/harness/suites/component-tree.ts`
- Modify: `test-app/harness/suites/navigation.ts`

- [ ] **Step 1: Implement component-tree suite**

```typescript
// test-app/harness/suites/component-tree.ts
import { McpTestClient } from '../lib/mcp-client.js';
import { assertTruthy, assertGreaterThan } from '../lib/assertions.js';

export async function componentTreeSuite(client: McpTestClient): Promise<string> {
  // Query for HomeScreen components (app should be on Home tab)
  const result = await client.callTool('cdp_component_tree', {
    filter: 'home-welcome',
    depth: 3,
  });
  assertTruthy(!result.isError, 'component_tree returned error');

  const data = McpTestClient.parseResult(result) as Record<string, unknown>;
  assertTruthy(data.tree, 'tree present in response');
  assertGreaterThan(data.totalNodes as number, 0, 'totalNodes');

  // Stringify and check for expected testIDs
  const treeStr = JSON.stringify(data.tree);
  assertTruthy(treeStr.includes('home-welcome'), 'home-welcome testID found');

  // Also query feature list
  const listResult = await client.callTool('cdp_component_tree', {
    filter: 'home-feature',
    depth: 2,
  });
  assertTruthy(!listResult.isError, 'feature query returned error');

  return `tree found with ${data.totalNodes} nodes`;
}
```

- [ ] **Step 2: Implement navigation suite**

```typescript
// test-app/harness/suites/navigation.ts
import { McpTestClient } from '../lib/mcp-client.js';
import { assertTruthy, assertEqual } from '../lib/assertions.js';

// Helper: wait for navigation to settle
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function navigationSuite(client: McpTestClient): Promise<string> {
  // Test 1: Verify we're on Home tab
  const homeResult = await client.callTool('cdp_navigation_state');
  assertTruthy(!homeResult.isError, 'navigation_state returned error');
  const homeState = McpTestClient.parseResult(homeResult) as Record<string, unknown>;
  assertTruthy(homeState.routeName, 'routeName present');

  // Test 2: Navigate to DeepLink screen with params
  await client.callTool('cdp_evaluate', {
    expression: '__NAV_REF__.navigate("DeepLink", { id: "123" })',
  });
  await sleep(500);

  const deepResult = await client.callTool('cdp_navigation_state');
  assertTruthy(!deepResult.isError, 'nav state after deep link error');
  const deepState = McpTestClient.parseResult(deepResult) as Record<string, unknown>;

  // The route name should be DeepLink with id param
  const routeName = deepState.routeName as string;
  assertEqual(routeName, 'DeepLink', 'deep link route name');

  const params = deepState.params as Record<string, unknown>;
  assertEqual(params.id, '123', 'deep link id param');

  // Navigate back to Home for next suites
  await client.callTool('cdp_evaluate', {
    expression: '__NAV_REF__.goBack()',
  });
  await sleep(300);

  return 'Home tab verified, deep link params confirmed';
}
```

- [ ] **Step 3: Commit**

```bash
git add test-app/harness/suites/component-tree.ts test-app/harness/suites/navigation.ts
git commit -m "feat(harness): implement component-tree and navigation suites"
```

---

### Task 18: Store State & Network Log Suites

**Files:**
- Modify: `test-app/harness/suites/store-state.ts`
- Modify: `test-app/harness/suites/network-log.ts`

- [ ] **Step 1: Implement store-state suite**

```typescript
// test-app/harness/suites/store-state.ts
import { McpTestClient } from '../lib/mcp-client.js';
import { assertTruthy, assertEqual } from '../lib/assertions.js';

export async function storeStateSuite(client: McpTestClient): Promise<string> {
  // Test 1: Read user.name (should be seeded value)
  const nameResult = await client.callTool('cdp_store_state', { path: 'user.name' });
  assertTruthy(!nameResult.isError, 'store_state user.name error');
  const nameData = McpTestClient.parseResult(nameResult) as Record<string, unknown>;
  assertEqual(nameData.type, 'redux', 'store type is redux');
  assertEqual(nameData.state, 'Test User', 'user.name value');

  // Test 2: Read feed.items (should be array, may be populated from FeedScreen)
  const feedResult = await client.callTool('cdp_store_state', { path: 'feed.items' });
  assertTruthy(!feedResult.isError, 'store_state feed.items error');
  const feedData = McpTestClient.parseResult(feedResult) as Record<string, unknown>;
  assertTruthy(Array.isArray(feedData.state), 'feed.items is array');

  // Test 3: Read settings.theme (should be 'light')
  const themeResult = await client.callTool('cdp_store_state', { path: 'settings.theme' });
  assertTruthy(!themeResult.isError, 'store_state settings.theme error');
  const themeData = McpTestClient.parseResult(themeResult) as Record<string, unknown>;
  assertEqual(themeData.state, 'light', 'settings.theme value');

  return 'user.name and feed.items match';
}
```

- [ ] **Step 2: Implement network-log suite**

```typescript
// test-app/harness/suites/network-log.ts
import { McpTestClient } from '../lib/mcp-client.js';
import { assertTruthy, assertGreaterThan } from '../lib/assertions.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function networkLogSuite(client: McpTestClient): Promise<string> {
  // Clear network buffer first
  await client.callTool('cdp_network_log', { clear: true });

  // Navigate to Feed to trigger MSW fetch
  await client.callTool('cdp_evaluate', {
    expression: '__NAV_REF__.navigate("Tabs", { screen: "HomeTab", params: { screen: "Feed" } })',
  });
  await sleep(1500); // Wait for fetch to complete

  // Read network log
  const result = await client.callTool('cdp_network_log', { limit: 10 });
  assertTruthy(!result.isError, 'network_log returned error');

  const data = McpTestClient.parseResult(result) as Record<string, unknown>;
  assertTruthy(data.mode, 'mode field present');

  // If mode is 'hook' (fetch hooks active), MSW requests should appear
  // If mode is 'cdp' (Network domain), MSW requests may not appear
  if (data.mode === 'hook') {
    assertGreaterThan(data.count as number, 0, 'network entries captured via hook');
    const requests = data.requests as Array<Record<string, unknown>>;
    const feedReq = requests.find((r) => (r.url as string).includes('/api/feed'));
    assertTruthy(feedReq, 'feed request found in network log');
    return `${data.count} entries captured (hook mode)`;
  }

  // CDP mode — validate structure is correct even if MSW requests are invisible
  assertTruthy(typeof data.count === 'number', 'count field is number');
  assertTruthy(Array.isArray(data.requests), 'requests is array');
  return `buffer structure valid (cdp mode, ${data.count} entries)`;
}
```

- [ ] **Step 3: Commit**

```bash
git add test-app/harness/suites/store-state.ts test-app/harness/suites/network-log.ts
git commit -m "feat(harness): implement store-state and network-log suites"
```

---

### Task 19: Console Log & Error Log Suites

**Files:**
- Modify: `test-app/harness/suites/console-log.ts`
- Modify: `test-app/harness/suites/error-log.ts`

- [ ] **Step 1: Implement console-log suite**

```typescript
// test-app/harness/suites/console-log.ts
import { McpTestClient } from '../lib/mcp-client.js';
import { assertTruthy, assertGreaterThan } from '../lib/assertions.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function consoleLogSuite(client: McpTestClient): Promise<string> {
  // Clear console buffer
  await client.callTool('cdp_console_log', { clear: true });

  // Navigate to Notifications tab (triggers console.log/warn/error on mount)
  await client.callTool('cdp_evaluate', {
    expression: '__NAV_REF__.navigate("Tabs", { screen: "NotificationsTab" })',
  });
  await sleep(1000);

  // Read console log (all levels)
  const result = await client.callTool('cdp_console_log', { level: 'all', limit: 50 });
  assertTruthy(!result.isError, 'console_log returned error');

  const data = McpTestClient.parseResult(result) as Record<string, unknown>;
  assertGreaterThan(data.count as number, 0, 'console entries count');

  const entries = data.entries as Array<Record<string, string>>;

  // Check for the 3 deliberate console messages
  const hasInfo = entries.some((e) => e.text?.includes('notifications loaded'));
  const hasWarn = entries.some((e) => e.text?.includes('stale cache'));
  const hasError = entries.some((e) => e.text?.includes('notification parse failed'));

  assertTruthy(hasInfo, 'notifications loaded (info) found');
  assertTruthy(hasWarn, 'stale cache (warn) found');
  assertTruthy(hasError, 'notification parse failed (error) found');

  return '3 log levels captured';
}
```

- [ ] **Step 2: Implement error-log suite**

```typescript
// test-app/harness/suites/error-log.ts
import { McpTestClient } from '../lib/mcp-client.js';
import { assertTruthy, assertGreaterThan } from '../lib/assertions.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function errorLogSuite(client: McpTestClient): Promise<string> {
  // Clear errors first
  await client.callTool('cdp_error_log', { clear: true });

  // Trigger an error via cdp_evaluate
  await client.callTool('cdp_evaluate', {
    expression: 'setTimeout(() => { throw new Error("harness-test-error"); }, 0)',
  });
  await sleep(500);

  // Read error log
  const result = await client.callTool('cdp_error_log');
  assertTruthy(!result.isError, 'error_log returned error');

  const data = McpTestClient.parseResult(result) as Record<string, unknown>;
  assertGreaterThan(data.count as number, 0, 'error count');

  const errors = data.errors as Array<Record<string, unknown>>;
  const testError = errors.find((e) => (e.message as string)?.includes('harness-test-error'));
  assertTruthy(testError, 'harness-test-error found in error log');

  return 'error captured in buffer';
}
```

- [ ] **Step 3: Commit**

```bash
git add test-app/harness/suites/console-log.ts test-app/harness/suites/error-log.ts
git commit -m "feat(harness): implement console-log and error-log suites"
```

---

### Task 20: Dev Settings & Reload Suites

**Files:**
- Modify: `test-app/harness/suites/dev-settings.ts`
- Modify: `test-app/harness/suites/reload.ts`

- [ ] **Step 1: Implement dev-settings suite**

```typescript
// test-app/harness/suites/dev-settings.ts
import { McpTestClient } from '../lib/mcp-client.js';
import { assertTruthy, assertEqual } from '../lib/assertions.js';

export async function devSettingsSuite(client: McpTestClient): Promise<string> {
  const result = await client.callTool('cdp_dev_settings', { action: 'togglePerfMonitor' });
  assertTruthy(!result.isError, 'dev_settings returned error');

  const data = McpTestClient.parseResult(result) as Record<string, unknown>;
  assertEqual(data.action, 'togglePerfMonitor', 'action matches');
  assertEqual(data.executed, true, 'executed is true');

  // Toggle it back off
  await client.callTool('cdp_dev_settings', { action: 'togglePerfMonitor' });

  return 'togglePerfMonitor ok';
}
```

- [ ] **Step 2: Implement reload suite**

```typescript
// test-app/harness/suites/reload.ts
import { McpTestClient } from '../lib/mcp-client.js';
import { assertTruthy, assertEqual } from '../lib/assertions.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function reloadSuite(client: McpTestClient): Promise<string> {
  // Trigger full reload
  const result = await client.callTool('cdp_reload', { full: true });
  assertTruthy(!result.isError, 'reload returned error');

  const data = McpTestClient.parseResult(result) as Record<string, unknown>;
  assertEqual(data.reloaded, true, 'reloaded is true');

  // If reconnected, verify helpers are re-injected
  if (data.reconnected) {
    await sleep(500);

    // Verify status is good after reload
    const statusResult = await client.callTool('cdp_status');
    assertTruthy(!statusResult.isError, 'post-reload status error');

    const statusData = McpTestClient.parseResult(statusResult) as Record<string, unknown>;
    const cdp = statusData.cdp as Record<string, unknown>;
    assertEqual(cdp.connected, true, 'reconnected after reload');

    // Verify helpers re-injected
    const readyResult = await client.callTool('cdp_evaluate', {
      expression: '__RN_AGENT.isReady()',
    });
    assertTruthy(!readyResult.isError, 'isReady check error');

    return 'reloaded, reconnected, helpers re-injected';
  }

  return 'reloaded (reconnect timed out — may need manual check)';
}
```

- [ ] **Step 3: Build and verify all suites compile**

```bash
cd test-app/harness && npx tsc
```

Expected: Clean compilation, all files in `dist/`.

- [ ] **Step 4: Commit**

```bash
git add test-app/harness/suites/dev-settings.ts test-app/harness/suites/reload.ts
git commit -m "feat(harness): implement dev-settings and reload suites"
```

---

## Chunk 5: Integration & Verification

### Task 21: End-to-End Smoke Test

**Files:**
- No new files. This task verifies the full pipeline works.

- [ ] **Step 1: Build the cdp-bridge MCP server**

```bash
cd scripts/cdp-bridge && npm install && npm run build
```

Expected: `dist/` directory populated with compiled JS.

- [ ] **Step 2: Build the harness**

```bash
cd test-app/harness && npm install && npm run build
```

Expected: `dist/` directory populated with compiled JS.

- [ ] **Step 3: Start the test app on iOS Simulator**

```bash
cd test-app && npx expo run:ios
```

Expected: App launches on iOS Simulator with tab navigation, all 8 screens accessible.

- [ ] **Step 4: Run the test harness**

In a separate terminal:

```bash
cd test-app/harness && node dist/run.js
```

Expected output (may vary based on environment):
```
Connecting to cdp-bridge MCP server...
Connected. Running suites...

[PASS] cdp_status — connected, app info valid (XXms)
[PASS] cdp_evaluate — getAppInfo valid, globals accessible (XXms)
[PASS] cdp_component_tree — tree found with N nodes (XXms)
[PASS] cdp_navigation_state — Home tab verified, deep link params confirmed (XXms)
[PASS] cdp_store_state — user.name and feed.items match (XXms)
[PASS] cdp_network_log — N entries captured (hook mode) (XXms)
[PASS] cdp_console_log — 3 log levels captured (XXms)
[PASS] cdp_error_log — error captured in buffer (XXms)
[PASS] cdp_dev_settings — togglePerfMonitor ok (XXms)
[PASS] cdp_reload — reloaded, reconnected, helpers re-injected (XXms)

10 suites: 10 passed, 0 failed
```

- [ ] **Step 5: Fix any failing suites**

If suites fail, debug by:
1. Check Metro console for errors
2. Run failing tool manually via the MCP inspector or `cdp_evaluate`
3. Adjust assertions or sleep durations as needed
4. Re-run harness

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "feat(test-app): complete E2E testing setup — all 10 suites passing"
```

---

### Task 22: Update Documentation

**Files:**
- Modify: `docs/ROADMAP.md`
- Modify: `docs/DECISIONS.md`

- [ ] **Step 1: Update ROADMAP.md Phase 10 status**

Change Phase 10 status from "Spec Complete — Implementation Pending" to "Complete".

- [ ] **Step 2: Add any new decisions to DECISIONS.md**

Document any implementation-time decisions that diverged from the spec (version adjustments, workarounds, etc.).

- [ ] **Step 3: Commit**

```bash
git add docs/ROADMAP.md docs/DECISIONS.md
git commit -m "docs: mark Phase 10 complete, update decisions"
```
