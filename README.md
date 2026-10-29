# Pucked Video

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
- XBotGo highlight-button presses imported as Highlight tags
- YouTube links, with the same tagging and stepping
- Teams and rosters, so a tag can say which player it's about
- Clips: change how much of each play a tag covers, save a clip as an MP4, or **Make reel** from the plays and player you pick, with the play name shown on each clip. Encoding uses the graphics card when it can.
- **Draw** (D) on a paused frame with arrows, lines, circles and a pen, then **Save picture** to share it
- **Auto highlights**: a reel of the best 1, 2, 3 or 5 minutes, picked from your tags, XBotGo clicks and AI plays (goals first, then plays with a player, plays close together, and plays where the camera was swinging)
- **Auto-Cut**: listens for the referee's whistle and reads the XBotGo camera log to find stoppages, shades them on the timeline, can skip them while you watch, and saves a condensed game (no re-encoding, so it takes a minute). Tagged plays are never cut.
- **Follow a player**: pick anyone on your roster, or anyone Hockey AI tracked, and step through every stretch of the game they were in (Prev/Next or [ and ]), play only their stretches back to back, or save them as one video. It uses Hockey AI's `<run>_presence.json` when the game has been analyzed, and the plays tagged with that player otherwise.
- **YouTube chapters** made from your tags, ready to paste into a video description
- Hockey AI (optional, runs on your PC): set it up in **Hockey AI**, then use **Analyze game** on a game. You click a few rink markings once per game (**Set up rink**). The analysis runs overnight, and the plays it finds show up as suggestions to keep or drop. **AI players** fixes the jersey numbers it read, and the **post-game report** prints a summary. The app runs Hockey_AI as described in its `docs/app_contract.md`.

## Keyboard

| Key | Action |
|---|---|
| Space | Play/pause |
| ← / → | Back/forward 5s |
| , / . | Previous/next frame |
| Letter keys | Tag (shown on each button) |
| 0-9 | Pick the player for the last tag, by jersey number |
| U | Undo the last tag you added (or the last mark while drawing) |
| D | Draw on the video (Esc to stop) |
| [ / ] | Previous/next stretch while following a player |
| - / + | Slower/faster |

## Adding a sport

Copy `sports/hockey.json` and change the `id`, `name`, and `tags`. Each tag sets a hotkey, a color, and how many seconds before and after the tag to include when it becomes a clip.

## Build installers

`npm run dist` builds a `.dmg` on a Mac and an `.exe` installer on Windows. Each one has to be built on its own OS.
