# Almanac for Windows

> [!WARNING]
> **Work in progress: don't use this yet.** The Windows app isn't finished or released, and things will change. Use the Almanac website in the meantime.

Your Almanac in its own window, with a tray icon by the clock and Windows notifications. It shows the Almanac website itself, so every feature is there and always up to date; there's nothing to keep in step.

- **First run:** enter your Almanac's address, then sign in as usual (username, password and 2FA code). It stays signed in like a browser would.
- **Notifications:** new account flags (choose the level), suspension requests and their outcomes, and server alerts (streams dropping, Uptime Kuma servers down or back up). Clicking one opens the right page. Almanac only shows each person what their role allows, the same as the website.
- **Tray icon:** open Almanac, choose notifications, start with Windows (quietly, in the tray), keep running when the window is closed, change the address, quit.
- Links to other sites open in your normal browser.

It asks Almanac for new alerts every 30 seconds (`GET /api/app/events`), so the Almanac server needs to be up to date (`sudo almanac-update`).

## Getting the installer

GitHub builds it on Windows whenever this folder changes: **Actions → Desktop app → the latest run → Artifacts → Almanac-Windows-installer**. Unzip it and run `Almanac-Setup-0.1.0.exe`.

The installer isn't code-signed yet, so Windows SmartScreen will say it's from an unknown publisher: choose **More info → Run anyway**. Signing needs a code-signing certificate (from about $100 a year) before a public release.

## Developing

```bash
cd desktop
npm install
npm start            # runs it on this computer (Windows, Mac or Linux)
npm run dist:win     # builds the Windows installer into dist/ (best run on Windows)
```

Plain JavaScript with no build step: `src/main.js` (the window, tray, settings and alerts), `src/preload.js` (gives only the app's own pages a way to talk to it, never the website), and the address and offline screens in `src/*.html`. Settings are kept in `%APPDATA%/Almanac/settings.json`.
