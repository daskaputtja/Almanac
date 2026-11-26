# Almanac for iPhone and Android

> [!WARNING]
> **Work in progress: don't use this yet.** The phone app isn't finished or released, and things will change. Use the Almanac website in the meantime.

The phone app for Almanac, built with React Native and Expo. It connects to any Almanac server (they're all self-hosted), signs in with the same username, password and two-factor code as the website, and covers what admins and mods need on the go:

- **Activity:** who's watching right now, refreshed every 10 seconds
- **Moderation:** open account flags (mark them as reviewed), and suspension requests (admins approve or reject them)
- **Users:** search by name or email; each account's flags, notes, suspension, offline downloads, signed-in devices and recent plays
- **Server:** Silo's health, nodes, dropped streams today, and your Uptime Kuma servers
- **Notifications:** new account flags, suspension requests and their outcomes, streams dropping and servers going down, each switchable, with an option to hide names on the lock screen

Statistics, history, recaps and settings stay on the website; the app links to it.

The app needs an Almanac with phone app support (`sudo almanac-update` gets it).

## Try it on your phone (with a Mac)

You need [Node.js 22](https://nodejs.org) on the Mac and the **Expo Go** app on your phone.

```bash
cd mobile
npm install
npx expo start --go
```

Scan the QR code with your phone's camera (iPhone) or Expo Go (Android). Everything works in Expo Go except **push notifications**, which need a development build (below). Without `--go`, Expo makes a QR code for the development build instead, which only works once that's installed (press `s` to switch).

Ignore npm's "vulnerabilities" notices and don't run `npm audit fix --force`: it can install versions that don't match the Expo SDK.

## Set up building (once)

1. Make a free account at [expo.dev](https://expo.dev), then:
   ```bash
   npx eas-cli@latest login
   npx eas-cli@latest init
   ```
   `init` creates the project on Expo and writes its ID into `app.json`. Commit that change: notifications need it.
2. **iPhone:** join the [Apple Developer Program](https://developer.apple.com/programs/) ($99 a year). EAS creates the certificates and the push notification key for you during the first build.
3. **Android:** make a Firebase project, add an Android app with the package `io.github.daskaputtja.almanac`, download `google-services.json` into this folder, add `"googleServicesFile": "./google-services.json"` under `android` in `app.json`, and upload the Firebase service account key to Expo (`npx eas-cli@latest credentials`). This is what lets Expo deliver notifications to Android phones.

## Test notifications on a real phone

```bash
npx eas-cli@latest build --profile development --platform ios      # or android
```

Install the build on your phone from the link EAS gives you, run `npx expo start` (without `--go`), and open the app. In **More → Notifications**, turn them on and send a test.

(With Xcode on the Mac you can also build locally with `npx expo run:ios --device`.)

## Release to the App Store and Google Play

```bash
npx eas-cli@latest build --profile production --platform all
npx eas-cli@latest submit --platform ios
npx eas-cli@latest submit --platform android
```

Before the first release, the stores need:

- **App icons and screenshots:** the icons are in `assets/`; take screenshots from the development build.
- **A privacy policy link.** The app sends nothing anywhere except to the Almanac server the user enters, and push notifications through Expo, Apple and Google.
- **A demo server for Apple's review.** Apple has to be able to sign in. Run an Almanac in demo mode (`SILO_MOCK=true`) on a public address with a test account, and give Apple its address, username, password, and how to get a 2FA code (for example a recovery code).
- **Google Play's data safety form and content rating.**

## Notes for developers

- Screens live in `src/app/` (Expo Router); shared pieces in `src/lib/` and `src/components/`.
- Types come from Almanac's `../shared/` folder with `import type` only, so the app and the server always agree on what the API returns.
- Expo SDK 58. Use `npx expo install <package>` to add packages (it picks versions that match the SDK). Check with `npm run typecheck`.
- `.npmrc` sets `legacy-peer-deps`, because some Expo packages list web-only libraries the app doesn't use.
