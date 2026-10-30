# Demo video: how it was made

- **Video:** {{VIDEO_URL}}. The source file `agentaisle-demo.mp4` is kept out of git (see `.gitignore`). It is 1920x1080, 30 fps, H.264 + AAC, **2:43.7** (163.7 s, measured with ffprobe). Cover: `cover.png`. Sample frames: `frames/`.
- **Recorded:** Oct 29, 2026 (CT) from the live public demo, https://agentaisle-demo.kamalkatul92-kk.workers.dev, in a headless-server Chrome (Xvfb + puppeteer-core) captured with ffmpeg. PayPal **sandbox** only; Pecan Plume Coffee Co. is a **fictional** merchant.
- **Read-only:** no merchant token was used and nothing was clicked that changes data. The new rows in shot 2 are the real hourly simulator run at 2:17 PM CT arriving on the live desk. In shot 4 the cursor hovers Approve but does not click it.
- **Narration:** synthetic speech made locally with [Piper](https://github.com/rhasspy/piper) (open-source TTS) and the public-domain **LJ Speech** voice. It does not imitate any real person. Captions are burned in. There is no music.
- **Shot 7 (terminal):** an on-screen replay of **real captured output**. `npm test` (85 passed, 5 skipped sandbox probes) ran at 2:12 PM CT, and `npm run verify:grid` (22 rows checked, 0 mismatches, 5 unapproved orders already expired at PayPal) ran at 2:21 PM CT. The clip is labelled "Replay of real command output".
- **Shot 8:** an architecture card (redrawn from the README diagram) and the end card.
- Third-party marks shown are limited to the tools actually used (PayPal, AG Grid, Cloudflare).
