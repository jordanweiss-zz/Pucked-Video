# Pucked Video

A desktop app for reviewing XBotGo Falcon game film, in the style of Hudl. Hockey comes first, and other sports are added as presets in `sports/`.

## Run it

You need Node.js 20 or newer.

```bash
npm install
npm start
```

## What it does

### Watching and tagging
- Opens local MP4s straight from disk with no upload, so files up to 30 GB work. YouTube links work too, with the same tagging and stepping.
- Play and pause, 5-second skips, frame-by-frame stepping, and speeds from 0.25× to 2×.
- A sport selector (Hockey, Soccer) that switches the set of tag buttons.
- One-key tagging (G = Goal, S = Shot, and so on), with a tag list you can click to jump to a play. Tags are saved next to the video as `<video>.tags.json`.
- XBotGo highlight-button presses are imported as Highlight tags.
- **Teams & rosters**, so a tag can say which player it's about (type the jersey number after tagging).
- **Draw** (D) on a paused frame with arrows, lines, circles and a pen, then **Save picture** to share it.

### Clips and reels
- Click any play or AI event to watch it. Its clip shows as a band on the timeline: drag either end, use **Start here** / **End here** (I and O), or type up to 2 minutes either side, then **Save clip** as an MP4.
- **Make reel** joins the plays and player you pick, with the play name shown at the start of each clip.
- **Save 9:16** and vertical reels for phones and social media. **Frame 9:16** lets you drag to choose which part of the picture to keep.
- **Team logo** in a corner of clips and reels, with size and see-through settings.
- **Auto highlights** builds a reel of the best 1, 2, 3 or 5 minutes from your tags, XBotGo clicks and AI plays. Goals come first, then plays with a player, plays close together, and plays where the camera was swinging.
- **Auto-Cut** finds the stoppages by listening for the referee's whistle and reading the XBotGo camera log. It shades them on the timeline, can skip them while you watch, and saves a condensed game with no re-encoding, so it takes about a minute. Tagged plays are never cut.
- **Follow a player**: pick anyone on your roster, or anyone Hockey AI tracked, and step through every stretch of the game they were in (Prev/Next, or `[` and `]`). You can play only their stretches back to back, or save them as one video.
- **YouTube chapters** made from your tags, ready to paste into a video description.
- Encoding uses the graphics card when it can (AMD, Apple, NVIDIA or Intel), and the bundled ffmpeg otherwise.

### Hockey AI (optional, runs on your own computer)
- Set it up in **Hockey AI**, then use **Analyze game** on a game. You click a few rink markings once per game in **Set up rink**.
- The analysis runs for a few hours. If it crashes or is stopped, **Resume** carries on from where it stopped (or **Start over**). The plays it finds show up as suggestions to keep (✓) or drop (✗).
- **AI players** fixes the jersey numbers it read, and the **post-game report** makes a printable PDF summary. Choose which team it's about and which players get their own pages; the territory and event map, game flow and plays-by-type pages always show both teams.
- The app runs [Hockey_AI](https://github.com/OsikDerek/Hockey_AI) as described in its `docs/app_contract.md`. Follow a player uses its `<run>_presence.json`.

Every setting is in the app's screens. There are no config files to edit.

## Not tested yet on a real PC

These were built and tested in a headless test setup but haven't been tried on the Windows PC yet:
- Graphics-card encoding (`h264_amf`) on an H.265 game.
- Auto-Cut's whistle detection on real rink sound. Its thresholds are a first guess.
- The full Hockey AI run from the app.

## Still to come

- Game library: a home screen of all your games (work in progress on the `feat/library` branch)
- Periods and game clock
- Syncing sound from a separate recorder
- Running the AI on another computer (for example a Mac Mini) on your home network

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
| I / O | Start/end the selected play's clip where the video is |
| - / + | Slower/faster |

## Adding a sport

Copy `sports/hockey.json` and change the `id`, `name`, and `tags`. Each tag sets a hotkey, a color, and how many seconds before and after the tag to include when it becomes a clip.

## Build installers

`npm run dist` builds a `.dmg` on a Mac and an `.exe` installer on Windows. Each one has to be built on its own OS.
