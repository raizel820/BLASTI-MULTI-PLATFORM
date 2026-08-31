# BLASTI Alarm Sound

The `android/app/src/main/res/raw/` directory should contain `blasti_alarm.wav` —
the custom alarm sound played when a customer's turn is called.

> **Note:** Do NOT place `README.md` (or any file with an uppercase letter in its
> name) inside `res/raw/` or any other `res/` subfolder. Android's AAPT2 rejects
> file-based resource names containing uppercase letters with the error:
> `'R' is not a valid file-based resource name character: File-based resource
> names must contain only lowercase a-z, 0-9, or underscore`.
> Keep this documentation in `apps/mobile/docs/` instead.

## Requirements

- **Filename**: `blasti_alarm.wav`
- **Format**: WAV (PCM 16-bit, 44100 Hz recommended)
- **Duration**: 1–3 seconds (will be looped by the notification system)
- **Volume**: Normalized to -3 dBFS for maximum audibility

## How to add the file

1. Place `blasti_alarm.wav` in `android/app/src/main/res/raw/`
2. On Android, this resource is referenced by the notification channel as
   `blasti_alarm` (without the `.wav` extension)
3. The Capacitor `LocalNotifications` plugin will use this sound via the channel
   config:
   ```typescript
   {
     id: 'blasti-turn-alert',
     sound: 'blasti_alarm.wav',
     importance: 5,
   }
   ```

## Web Fallback

For the web version, place a copy at `apps/web/public/blasti_alarm.wav`.
The `AggressiveTurnAlert` component will attempt to play it via
`new Audio('/blasti_alarm.wav')`.
