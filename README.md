# Video Review

A desktop app for reviewing XBotGo Falcon game film, in the style of Hudl. Hockey comes first, and other sports are added as presets in `sports/`.

## Run it

You need Node.js 20 or newer.

```bash
npm install
npm start
```

## What works now

- Opening a local MP4 straight from disk, with no upload, so files up to 30 GB work
- Play and pause, 5-second skips, frame-by-frame stepping, and speeds from 0.25× to 2×
- A sport selector (Hockey, Soccer) that switches the set of tag buttons
- One-key tagging (G = Goal, S = Shot, and so on), with a tag list you can click to jump to a play
- Tags saved automatically next to the video as `<video>.tags.json`
- Bundled ffmpeg (checked at startup) for exporting clips later

## Keyboard

| Key | Action |
|---|---|
| Space | Play/pause |
| ← / → | Back/forward 5s |
| , / . | Previous/next frame |
| Letter keys | Tag (shown on each button) |

## Adding a sport

Copy `sports/hockey.json` and change the `id`, `name`, and `tags`. Each tag sets a hotkey, a color, and how many seconds before and after the tag to include when it becomes a clip.

## Build installers

`npm run dist` builds a `.dmg` on a Mac and an `.exe` installer on Windows. Each one has to be built on its own OS.
