import '../global.css';
import React from 'react';
import { Provider } from 'react-redux';
import { PersistGate } from 'redux-persist/integration/react';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { store, persistor } from './store';
import RootNavigator, { linking } from './navigation/RootNavigator';
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
          <RootNavigator />
        </NavigationContainer>
      </PersistGate>
    </Provider>
  );
}
