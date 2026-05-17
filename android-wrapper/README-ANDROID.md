# Android Wrapper

This directory contains an optional Android WebView wrapper for the relay UI.

## What it does

- opens the relay URL like a native app
- stores the access token locally after first entry
- avoids relying on "Add to Home Screen" browser support

## Before building

Update these values in `app/build.gradle`:

- `applicationId`
- `namespace`
- `RELAY_BASE_URL`
- `WEB_APP_VERSION`

## Build

Use Android Studio or Gradle to build the APK:

```bash
./gradlew assembleDebug
```

## Privacy

This public wrapper source does not include any real token, VPS address, or user-specific path.
