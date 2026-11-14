import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Pressable, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../src/auth';
import { colors, s } from '../src/theme';

export default function SignIn() {
  const { signIn } = useAuth();
  const [mobile, setMobile] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      setError(await signIn(mobile, password));
    } catch {
      setError('Could not reach the server. Check your internet and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={s.screen}>
      <KeyboardAvoidingView style={s.pad}>
        <Text style={s.title}>Sign in</Text>
        <Text style={[s.muted, { marginTop: 6 }]}>Use your mobile number and the password from the office.</Text>
        <Text style={s.label}>Mobile number</Text>
        <TextInput
          style={s.input} value={mobile} onChangeText={setMobile} keyboardType="phone-pad"
          autoComplete="tel" placeholder="98765 43210" accessibilityLabel="Mobile number"
        />
        <Text style={s.label}>Password</Text>
        <TextInput
          style={s.input} value={password} onChangeText={setPassword} secureTextEntry
          autoCapitalize="none" autoCorrect={false} accessibilityLabel="Password"
        />
        {error ? <Text style={s.error} accessibilityRole="alert">{error}</Text> : null}
        <Pressable style={[s.button, busy && { opacity: 0.6 }]} onPress={submit} disabled={busy} accessibilityRole="button">
          {busy ? <ActivityIndicator color={colors.onPrimary} /> : <Text style={s.buttonText}>Sign in</Text>}
        </Pressable>
        <View />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
