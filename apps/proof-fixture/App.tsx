import { useState } from 'react';
import { Button, SafeAreaView, StyleSheet, Text, TextInput } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';

type Routes = {
  ProofHome: undefined;
  ProofForm: undefined;
  ProofResult: { name: string };
};

const Stack = createNativeStackNavigator<Routes>();

function ProofHome({ navigation }: { navigation: { navigate: (route: 'ProofForm') => void } }) {
  return (
    <SafeAreaView style={styles.screen} testID="proof-start">
      <Text style={styles.title}>Proof Factory</Text>
      <Text>Clean start state</Text>
      <Button
        testID="proof-open-form"
        title="Start exact feature"
        onPress={() => navigation.navigate('ProofForm')}
      />
    </SafeAreaView>
  );
}

function ProofForm({
  navigation,
}: {
  navigation: { navigate: (route: 'ProofResult', params: { name: string }) => void };
}) {
  const [name, setName] = useState('');
  return (
    <SafeAreaView style={styles.screen} testID="proof-form">
      <Text style={styles.title}>Name the feature</Text>
      <TextInput
        testID="proof-name-input"
        accessibilityLabel="Feature name"
        value={name}
        onChangeText={setName}
        placeholder="Feature name"
        style={styles.input}
      />
      <Button
        testID="proof-submit"
        title="Apply feature"
        disabled={name.trim().length === 0}
        onPress={() => navigation.navigate('ProofResult', { name: name.trim() })}
      />
    </SafeAreaView>
  );
}

function ProofResult({ route }: { route: { params: { name: string } } }) {
  return (
    <SafeAreaView style={styles.screen} testID="proof-result">
      <Text style={styles.title}>Feature accepted</Text>
      <Text testID="proof-result-name">{route.params.name}</Text>
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <NavigationContainer>
      <StatusBar style="dark" />
      <Stack.Navigator initialRouteName="ProofHome">
        <Stack.Screen name="ProofHome" component={ProofHome} />
        <Stack.Screen name="ProofForm" component={ProofForm} />
        <Stack.Screen name="ProofResult" component={ProofResult} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: 'center', gap: 20, padding: 24 },
  title: { fontSize: 28, fontWeight: '700' },
  input: { borderColor: '#777', borderRadius: 8, borderWidth: 1, padding: 12 },
});
