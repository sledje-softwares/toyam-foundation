import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Pressable, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../src/auth';
import { colors, s } from '../src/theme';

export default function SignIn() {
  const { signIn } = useAuth();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      setError(await signIn(login, password));
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
        <Text style={[s.muted, { marginTop: 6 }]}>Use the email (or mobile number) and the password from the office.</Text>
        <Text style={s.label}>Email or mobile number</Text>
        <TextInput
          style={s.input} value={login} onChangeText={setLogin} keyboardType="email-address"
          autoCapitalize="none" autoCorrect={false} autoComplete="username"
          placeholder="name@example.com" accessibilityLabel="Email or mobile number"
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
