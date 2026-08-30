import { useRef, useState } from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInput as TextInputHandle,
} from 'react-native';

(globalThis as typeof globalThis & {
  __NAV_REF__: {
    navigate: () => void;
    getRootState: () => { index: number; routes: { name: string }[] };
  };
}).__NAV_REF__ = {
  navigate: () => {},
  getRootState: () => ({ index: 0, routes: [{ name: 'Home' }] }),
};

export default function App() {
  const [code, setCode] = useState('');
  const [done, setDone] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const inputRef = useRef<TextInputHandle>(null);

  const openOtp = () => {
    setCode('');
    setDone(false);
    setModalVisible(false);
    setTimeout(() => setModalVisible(true), 5_000);
  };

  const submitOtp = () => {
    if (code !== '0451') return;
    setModalVisible(false);
    setDone(true);
  };

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Expo 55 dev client manifest fixture</Text>
      <Pressable testID="open_otp" onPress={openOtp} style={styles.button}>
        <Text style={styles.buttonText}>Open OTP</Text>
      </Pressable>
      {done ? <Text testID="otp_done">OTP complete</Text> : null}
      <Modal visible={modalVisible} transparent animationType="none">
        <View style={styles.backdrop}>
          <View style={styles.card}>
            <Text>Enter one-time code</Text>
            <Pressable
              testID="otp_email-pressable"
              accessibilityLabel="otp_email-pressable"
              onPress={() => inputRef.current?.focus()}
              style={styles.inputWrapper}
            >
              <TextInput
                ref={inputRef}
                testID="otp_email"
                value={code}
                onChangeText={setCode}
                keyboardType="number-pad"
              />
            </Pressable>
            <Pressable testID="otp_submit" onPress={submitOtp} style={styles.button}>
              <Text style={styles.buttonText}>Submit</Text>
            </Pressable>
            <Pressable testID="otp_cancel" onPress={() => setModalVisible(false)}>
              <Text>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 },
  title: { fontSize: 18 },
  backdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.35)',
  },
  card: { width: 280, gap: 16, padding: 24, borderRadius: 16, backgroundColor: 'white' },
  inputWrapper: { minHeight: 48, justifyContent: 'center', padding: 12, borderWidth: 1 },
  button: {
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: 20,
    backgroundColor: 'black',
  },
  buttonText: { color: 'white', textAlign: 'center' },
});
