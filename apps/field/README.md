# Field app (Android)

Expo SDK 58 (React Native 0.88, expo-router, TypeScript strict). Pieces 5.1 to 5.3 skeleton: sign-in, case list,
read-only thread. Design: `docs/11-field-app.md`. Camera, gallery, share intent, ML Kit and the offline outbox
(`src/outbox/`) come later and need native modules, so this app runs as a **custom development build**
(`expo-dev-client`), not Expo Go.

## Setup

```bash
npm install                       # at the repo root (workspaces)
cp apps/field/.env.example apps/field/.env
```

Environment (`apps/field/.env`, gitignored):

| Variable | Meaning |
| --- | --- |
| `EXPO_PUBLIC_SUPABASE_URL` | Supabase API URL. Emulator: `http://10.0.2.2:54321`. Phone: `http://<computer LAN IP>:54321`. |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | Anon / publishable key only. Never a service-role key (RLS is the security boundary). |

## Run against the local stack

1. `npx -y supabase@3.1.0 start` (then `db reset` for seed data); `npx -y supabase@3.1.0 status` shows the keys.
2. Create a field operator (web admin, or the seed) with a mobile number and password. Sign-in is
   mobile + password (K4, `FIELD_SIGN_IN = mobile_password`); the number is normalised to `+91...`.
3. Build and install the dev client, then start Metro:
   ```bash
   cd apps/field
   npx expo run:android     # needs the Android SDK (ANDROID_HOME), a JDK 17 and an emulator or USB device
   npm start                # Metro for the dev client
   ```
   No Android SDK was available when this was scaffolded, so the native build is untested; the JS bundle
   (`npx expo export --platform android`) is verified. No EAS account or cloud build is needed for local builds.

## Scripts

`npm run start | android | typecheck | lint | test` (vitest, pure logic in `src/lib`).

## Notes

- Session storage: LargeSecureStore (AES key in Keystore via expo-secure-store, encrypted session in
  expo-sqlite key-value storage), because a session exceeds the ~2 KB SecureStore limit.
- A non-field role is signed out straight after sign-in with a message.
- Cases come from `rpc field_case_list()`. The thread reads `case_messages` directly (no thread read function
  exists yet; RLS limits it to the operator's cases and non-staff messages).
- React: the web app hoists React 19.3.1; this app needs 19.3.0 for React Native 0.88, so it has its own copy
  in `apps/field/node_modules` and `metro.config.js` forces `react` to resolve there.
