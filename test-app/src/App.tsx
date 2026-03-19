import './dev-bridge';
import React from 'react';
import { View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Provider } from 'react-redux';
import { PersistGate } from 'redux-persist/integration/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { store, persistor } from './store';
import RootNavigator, { linking } from './navigation/RootNavigator';
import OfflineBanner from './components/OfflineBanner';
import SyncContext from './context/SyncContext';
import { useBackgroundSync } from './hooks/useBackgroundSync';
import type { RootStackParams } from './navigation/types';
import { enableMockFetch } from './mocks/interceptor';
import './store/usePreferencesStore';

if (__DEV__) {
  enableMockFetch();
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30000, gcTime: 300000 } },
});

const navigationRef = createNavigationContainerRef<RootStackParams>();

if (__DEV__) {
  (globalThis as Record<string, unknown>).__NAV_REF__ = navigationRef;
  const bridge = (globalThis as Record<string, unknown>).__RN_DEV_BRIDGE__ as { registerNavRef?: Function; registerStore?: Function } | undefined;
  bridge?.registerNavRef?.(navigationRef);
  bridge?.registerStore?.({ name: 'redux', type: 'redux', getState: () => store.getState(), dispatch: (action: unknown) => store.dispatch(action as never) });
}

function SyncBridge({ children }: { children: React.ReactNode }) {
  const sync = useBackgroundSync();
  return <SyncContext.Provider value={sync}>{children}</SyncContext.Provider>;
}

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={queryClient}>
        <Provider store={store}>
          <PersistGate loading={null} persistor={persistor}>
            <SyncBridge>
              <NavigationContainer ref={navigationRef} linking={linking}>
                <View style={{ flex: 1 }}>
                  <OfflineBanner />
                  <RootNavigator />
                </View>
              </NavigationContainer>
            </SyncBridge>
          </PersistGate>
        </Provider>
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}
