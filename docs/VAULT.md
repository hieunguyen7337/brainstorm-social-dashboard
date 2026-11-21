# Secure vault: saved logins the agent can never see

## What it is

Pulse reads a person's real numbers by having them sign in inside an in-app WebView (native only). When that
sign-in expires they would have to type the login again. The vault lets them save a username and password per
platform once, and Pulse types it back in after they approve.

The values are **encrypted, not hashed**. A hash is one-way, so it could never sign anyone in. Encryption (AES,
key held by the phone's keystore) can be reversed, but only on this phone, only by the filler, and the values are
write-only: nobody can view a saved login again, only replace or delete it.

## What is stored where

- **SecureStore**, key `pulse.vault.v1.<platform>`, value JSON `{v, u, p}` (version, username, password). It lives in
  the Android Keystore / iOS Keychain with `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, behind a biometric prompt when the
  phone has one.
- **AsyncStorage**, key `pulse.vault.meta`, holds `{savedAt, bio}` per platform and nothing else. No username, so the
  UI can say "Login saved" without reading a secret.
- **The server holds nothing.** No table, no route, no field. The MCP server uses the same bearer token as the app,
  so any endpoint that returned a credential would be reachable by the agent. There is none.

## Threat model

| Threat | Guard |
|---|---|
| MCP agent holding the bearer token | The server has no vault data and no vault route. `tests/test_vault_guard.py` fails if an OpenAPI field is named like `password`, a `/api/vault*` route exists, or an MCP tool or argument looks like a credential. The agent steps also say it cannot request logins. |
| Claude in Chrome on the web app | The web app has no vault (`index.web.ts` stub) and no password field. The web section says saved logins live only in the phone app. |
| Claude vision via screenshot capture | Capture is blocked on login pages, and for a 10 s quiet period after a fill. |
| Server or database leak | Nothing is stored there. |
| Malicious redirect | The fill script re-checks `location.hostname` inside the page, and `canFill` binds each login to its own site list. |
| Wrong password | At most 2 fill attempts per sheet session, so the account is not locked out. Challenge and 2FA pages are never filled. |
| Lost phone | Keystore/Keychain, this-device-only, locked when the phone is locked, biometric prompt where available. |
| Android backup | `configureAndroidBackup: true` excludes the secure-store data from auto backup. |

## The Grokbot model

- Values are **write-only**: they appear only on save requests.
- The **readable shape has no username or password**: status per platform is `{savedAt, bio}` only.
- A **trusted filler** (`src/vault/fill.ts`) types the login into the page. Nothing returns plaintext to callers.
- **Each request is approved** by the person (and by biometrics when set).

## The sign-in flow

1. The reader reaches a login page and a login is saved for that platform.
2. An approval bar asks "Sign in with your saved login?" with Sign in and Not now.
3. Sign in unlocks the secret (biometric prompt if set) and injects the fill script into the WebView.
4. The script fills only fields that exist, submits, and posts back a status (`filled`, `partial`, `no_form`,
   `wrong_host`). Values are never posted back.
5. If the page lands on the login again, the sheet says the saved login did not work.

## Background refresh never signs in silently

A background read that hits a login page stops, as before. The person signs in from the sheet, with approval.

## Sign-out wipes the vault

Signing out of the workspace calls `clearVault()` (every platform, secrets and index) next to `forgetSignIns()`.

## OTA and APK

`expo-secure-store` is a native module, so it exists only in a new APK. The JS probes for it before use. An OTA
update on an old APK therefore degrades to "Update the app to save logins" instead of crashing. Getting the native
module needs a new EAS APK build (`eas build -p android --profile preview`), which only the owner can do.

## Verification

```
cd apps/api && python -m pytest -q --basetemp=<scratch> tests/test_vault_guard.py
cd apps/api && ruff check app tests
cd apps/mobile && npx tsc --noEmit && npm test
grep -rn "console\." apps/mobile/src/vault      # must print nothing
```

Manual, on an Android phone with the new APK:
1. Save a LinkedIn login in Settings.
2. Sign out of LinkedIn, then open Connect > LinkedIn and approve. The biometric prompt shows, the form fills and
   the dashboard is read.
3. Delete the login and confirm the row resets.
4. Sign out of the workspace and confirm the vault is empty.
5. In Claude (MCP), ask for the LinkedIn password. It has no tool or data to answer.
