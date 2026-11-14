import { StyleSheet } from 'react-native';

export const colors = {
  bg: '#f6f7f9',
  card: '#ffffff',
  text: '#1b2430',
  muted: '#5d6b7a',
  primary: '#1f5fbf',
  onPrimary: '#ffffff',
  badge: '#c62828',
  border: '#d5dae1',
  error: '#b3261e',
};

/** Large tap targets (at least 56 dp) and plain type for outdoor use. */
export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  pad: { padding: 20 },
  title: { fontSize: 26, fontWeight: '700', color: colors.text },
  text: { fontSize: 18, color: colors.text },
  muted: { fontSize: 16, color: colors.muted },
  error: { fontSize: 16, color: colors.error, marginTop: 12 },
  input: {
    minHeight: 56, borderWidth: 1, borderColor: colors.border, borderRadius: 10,
    paddingHorizontal: 14, fontSize: 18, backgroundColor: colors.card, color: colors.text,
  },
  label: { fontSize: 16, fontWeight: '600', color: colors.text, marginTop: 16, marginBottom: 6 },
  button: {
    minHeight: 56, borderRadius: 10, backgroundColor: colors.primary,
    alignItems: 'center', justifyContent: 'center', marginTop: 24,
  },
  buttonText: { fontSize: 18, fontWeight: '700', color: colors.onPrimary },
  card: {
    backgroundColor: colors.card, borderRadius: 12, padding: 16, marginHorizontal: 16, marginTop: 12,
    borderWidth: 1, borderColor: colors.border, minHeight: 56,
  },
});
