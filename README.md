# RENDER RAIL — team edition

The full pipeline console, multi-user. Everyone gets their own account, connects their own API keys (encrypted at rest), and runs their own isolated queue and files.

The machine per clip: Director chat (Claude + character bibles) → ChatGPT or Nano Banana image with the character's master reference → Grok/Veo video with the generated image attached, or ElevenLabs audio → HeyGen Avatar IV talking clip. Every step auto-feeds the next.

## Launch it (about 10 minutes)

1. Put this folder in a GitHub repo (drag-and-drop upload on github.com works).
2. render.com → **New +** → **Blueprint** → connect the repo → **Apply**. The included `render.yaml` sets up the app, HTTPS, and a persistent 10 GB disk automatically (~$9.50/mo total).
3. You get a URL like `https://render-rail-team.onrender.com`. Open it, create your account, send your friend the link.

Railway also works (Dockerfile included): New Project → Deploy from GitHub → add a Volume mounted at `/var/rail` → Generate Domain.

**Back up** the disk occasionally: `data/` holds accounts, encrypted keys, chats, and character bibles; `outputs/` holds everyone's files. `data/.secret` is the encryption key.

## Per-user setup (each person, once)

1. Register → **Settings** → paste your keys: OpenAI (ChatGPT images), Gemini (Nano Banana + Veo), xAI (Grok), HeyGen, ElevenLabs, Anthropic (the Director)
2. **Director → Edit bibles** → your character → upload the master reference image
3. **Voice tab** → pick your ElevenLabs voice (its saved settings are pulled from your account automatically)

Then drop a script in the Director and ⚡ Run. Test with 2 clips before firing 12 — video bills per clip on each user's own accounts.
