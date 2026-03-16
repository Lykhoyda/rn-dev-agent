import React from 'react';
import { View } from 'react-native';
import { Provider } from 'react-redux';
import { PersistGate } from 'redux-persist/integration/react';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { store, persistor } from './store';
import RootNavigator, { linking } from './navigation/RootNavigator';
import OfflineBanner from './components/OfflineBanner';
import type { RootStackParams } from './navigation/types';

const navigationRef = createNavigationContainerRef<RootStackParams>();

if (__DEV__) {
  (globalThis as Record<string, unknown>).__NAV_REF__ = navigationRef;
}

export default function App() {
  return (
    <Provider store={store}>
      <PersistGate loading={null} persistor={persistor}>
        <NavigationContainer ref={navigationRef} linking={linking}>
          <View style={{ flex: 1 }}>
            <OfflineBanner />
            <RootNavigator />
          </View>
        </NavigationContainer>
      </PersistGate>
    </Provider>
  );
}
