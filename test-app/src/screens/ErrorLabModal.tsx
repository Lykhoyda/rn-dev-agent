import React, { useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParams } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParams, 'ErrorLab'>;

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
