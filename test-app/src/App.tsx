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
