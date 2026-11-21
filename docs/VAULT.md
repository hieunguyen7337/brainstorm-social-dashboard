# Secure vault: saved logins the agent can never see

## What it is

Pulse reads a person's real numbers by having them sign in inside an in-app WebView (native only). When that
sign-in expires they would have to type the login again. The vault keeps the username and password per platform: it is
saved by itself the first time the person signs in on the Connect sign-in sheet, and Pulse types it back in by itself
on a later login page. Settings > Saved logins stays for removing or replacing a login, and for the per-login
fingerprint / face prompt.

The values are **encrypted, not hashed**. A hash is one-way, so it could never sign anyone in. Encryption (AES,
key held by the phone's keystore) can be reversed, but only on this phone, only by the filler, and the values are
write-only: nobody can view a saved login again, only replace or delete it.

## What is stored where

- **SecureStore**, key `pulse.vault.v1.<platform>`, value JSON `{v, u, p}` (version, username, password). It lives in
  the Android Keystore / iOS Keychain with `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, behind a biometric prompt only when the
  person turned it on for that login (`bio`). A login saved at a Connect sign-in starts with it off (replacing one keeps
  its setting); one saved in Settings starts with it on; the Settings toggle flips it (`setLoginBio`).
- **AsyncStorage**, key `pulse.vault.meta`, holds `{savedAt, bio}` per platform and nothing else. No username, so the
  UI can say "Login saved" without reading a secret.
- Not part of this vault: the person's Claude API key is a separate SecureStore entry, `pulse.assistant.anthropic.v1`, with the same device-only rules (`apps/mobile/README.md`, Assistant section).
- **Memory only, at most 2 minutes**: the login typed on the sign-in sheet, between the tap on Log in and the page
  showing the sign-in worked (`src/vault/capture.ts`, `makeCaptureHolder`).
- **The WebView cookie store** (Android's, shared by the app's WebViews): the platform sign-in itself.
- **The server holds nothing.** No table, no route, no field. The MCP server uses the same bearer token as the app,
  so any endpoint that returned a credential would be reachable by the agent. There is none.

## Threat model

| Threat | Guard |
|---|---|
| MCP agent holding the bearer token | The server has no vault data and no vault route. `tests/test_vault_guard.py` fails if an OpenAPI field is named like `password`, a `/api/vault*` route exists, or an MCP tool or argument looks like a credential. The agent steps also say it cannot request logins. |
| Claude in Chrome on the web app | The web app has no vault (`index.web.ts` stub) and no password field. The web section says saved logins live only in the phone app. |
| Claude vision via screenshot capture | Capture is blocked on login pages, and for a 10 s quiet period after a fill. |
| Server or database leak | Nothing is stored there. |
| Malicious redirect | The fill and capture scripts re-check `location` inside the page with the tamper-proof `here()` (operators only, no page-replaceable method), and `canFill` binds each login to its own site list. |
| Typed login captured on the sign-in sheet | The capture script (`buildCaptureScript`) is injected only into the sign-in sheet's WebView, only when its NATIVE URL (`onNavigationStateChange` / `onLoadEnd`, never a page-reported href) passes `canFill`, and only with a vault on the phone. In the page it reads the fields only on a submit / login-button tap / Enter, only while `here()` passes and no one-time-code field shows, and posts each value pair once. Native (`makeCaptureHolder`) accepts it only while the native URL passes `canFill`, keeps it in memory, saves it once the page settles on a signed-in page of the same platform, and drops it on a login page again, another site, sheet close, or after 2 minutes. |
| Hostile iframe on a login page | react-native-webview exposes the bridge to every frame. A capture is accepted only when the message's native source (`nativeEvent.url`, the posting frame's origin on current Android WebViews) is the platform's own https origin (`captureOriginOk`), so an ad or captcha frame cannot plant a login. The same check guards the page's href answer that may confirm a sign-in. |
| Captured login leaking to logs, the server or Claude | `routeSheetMessage` (`autoRead/vaultOffer.ts`) decides captures first: a capture, or anything naming the capture tag, goes to the holder only, never to the runner (which logs and traces), the href poll, the trace (`POST /api/autoread/trace`) or the console. `autoRead/__tests__/vaultCapture.test.ts` runs the real script and a real runner + tracer and fails if the password shows up anywhere. Nothing in `src/vault` logs or calls the network (`store.test.ts`). |
| The fill's own submit re-saved as a new login | Captures are ignored from the moment a fill is injected until it reports (`fillStarted` / `fillEnded`, 15 s at most), and replacing a login keeps its biometric setting. |
| Wrong password | At most 2 fill attempts per sheet session, so the account is not locked out. Challenge and 2FA pages are never filled. A capture is saved only after the page leaves the login form for a signed-in page; the login form again saves nothing. |
| Claude's remote phone browser (`browser_*` MCP tools) | It is a separate WebView (`app/browser.tsx`). The vault only ever fills, and the capture only ever listens in, the sign-in sheet's WebView, never the remote browser (a source test checks `browserControl/**` and `app/browser.tsx` never touch them). Claude's `type` refuses password and one-time-code fields, and `read_text`/`elements` never return password values. A vault sign-in leaves session cookies the remote browser can use, but never the password; Disconnect and sign-out drop those cookies. |
| Background refresh | The hidden refresh WebView (`refresh.tsx`) never fills, captures or saves (source test). A read that hits a login page stops as before; the person's next sheet opens and fills itself. |
| Lost phone | Keystore/Keychain, this-device-only, locked when the phone is locked, biometric prompt where available. |
| Android backup | `configureAndroidBackup: true` excludes the secure-store data from auto backup. |

## The Grokbot model

- Values are **write-only**: they appear only on save requests (Settings, or the capture of a sign-in the person typed).
- The **readable shape has no username or password**: status per platform is `{savedAt, bio}` only.
- A **trusted filler** (`src/vault/fill.ts`) types the login into the page. Nothing returns plaintext to callers.
- **Each fill is the person's own sign-in flow**: only the sign-in sheet, only the platform's own login form, at most 2
  attempts, never a challenge page, behind biometrics when the person turned that on for the login.

## The sign-in flow

1. The reader reaches a login page (by its native URL) and a login is saved for that platform.
2. After the form had a moment to render, the sheet unlocks the secret (biometric prompt only if the person turned it on
   for that login) and injects the fill script. The sheet says "Signing you in with your saved login…"; there is no
   approval bar any more.
3. The script fills only fields that exist, submits, and posts back a status (`filled`, `partial`, `no_form`,
   `wrong_host`). Values are never posted back. A `no_form` (the form had not rendered) is tried once more.
4. At most 2 fills per sheet session; one per page load. Challenge and 2FA pages are never filled.
5. If the page lands on the login again, the sheet says the saved login did not work; signing in by hand then saves the
   new login.

## Saved when you sign in

1. On the platform's login form (native URL passes `canFill`) the sheet injects the capture script, which carries no
   secret. The sheet's note says the login typed there is saved on this phone.
2. On Log in it posts `{pulse: 'vaultCapture', platform, u, p}` once. Native holds it in memory if the message came
   from the platform's own origin and the native URL still passes `canFill`.
3. The page settles on a signed-in page of the same platform (`signInOutcome`: past login, or Instagram's / Facebook's
   "save your login" step): `saveLogin(platform, u, p, {bio})` runs and the sheet shows "Login saved on this phone.
   Remove it in Settings > Saved logins." (also as a toast, which outlives the sheet). Challenge / 2FA screens in between
   keep it held. The login page again, another site, closing the sheet or 2 minutes drop it.

## Staying signed in

The sheet's WebView is not incognito, and react-native-webview flushes Android's cookie store to disk on every finished
page (`RNCWebViewClient.onPageFinished` calls `CookieManager.flush()`), so a sign-in survives an app restart; Android's
WebView keeps session cookies across restarts too. No cookie module is added (it would need a new APK). Only two things
clear a sign-in and a saved login:

- **Sign-out of the workspace**: `clearVault()` (every platform) and `forgetSignIns()`.
- **Disconnect a platform** in Settings: `deleteLogin(platform)` and `forgetSignIns()` (`src/connect/forgetOnPhone.ts`).
  react-native-webview has no per-site cookie API, so this drops the in-app sign-in of every platform; the others keep
  their saved logins and their sheet signs them back in by itself. Clearing one site's cookies only would need
  `@react-native-cookies/cookies` in a new APK.

## Background refresh never signs in silently

A background read that hits a login page stops, as before (no fill, no capture in the hidden WebView). The person's next
sign-in sheet fills itself from the vault.

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
cd apps/mobile && npx tsc --noEmit && npm test   # incl. vault/__tests__/capture*.test.ts, autoRead/__tests__/vaultCapture.test.ts
grep -rn "console\." apps/mobile/src/vault      # must print nothing
```

Manual, on an Android phone with the new APK:
1. With no saved LinkedIn login, open Connect > LinkedIn and sign in by hand. "Login saved on this phone" shows and
   Settings > Saved logins lists LinkedIn. Type a wrong password first: nothing is saved until the right one works.
2. Force-stop the app and reopen it: Connect > LinkedIn reads without a login page.
3. Disconnect LinkedIn in Settings: its saved login is gone. Open Connect > Instagram (with a saved login): the sheet
   fills and submits it by itself, no bar, no biometric prompt.
4. Turn on "Ask for fingerprint or face" for Instagram, repeat 3: the prompt shows before the fill.
5. Sign out of the workspace and confirm the vault is empty.
6. In Claude (MCP), ask for the LinkedIn password. It has no tool or data to answer.
