import { Redirect, Stack, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, View } from 'react-native';
import { AuthProvider, useAuth } from '../src/auth';
import '../src/outbox/background'; // defines the background send task at module scope (5.7)
import { colors } from '../src/theme';

function Gate() {
  const { session, loading } = useAuth();
  const segments = useSegments();
  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }
  const onSignIn = segments[0] === 'sign-in';
  if (!session && !onSignIn) return <Redirect href="/sign-in" />;
  if (session && onSignIn) return <Redirect href="/" />;
  return (
    <Stack screenOptions={{ headerStyle: { backgroundColor: colors.card }, headerTitleStyle: { fontSize: 20 } }}>
      <Stack.Screen name="sign-in" options={{ headerShown: false }} />
      <Stack.Screen name="index" options={{ title: 'My cases' }} />
      <Stack.Screen name="case/[id]" options={{ title: 'Case' }} />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <StatusBar style="dark" />
      <Gate />
    </AuthProvider>
  );
}
