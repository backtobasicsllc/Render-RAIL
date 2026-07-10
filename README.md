# RENDER RAIL — team edition

The full pipeline console, multi-user. Everyone gets their own account, connects their own API keys (encrypted at rest), and runs their own isolated queue and files.

The machine per clip: Director chat (Claude + character bibles) → ChatGPT or Nano Banana image with the character's master reference → Grok/Veo video with the generated image attached, or ElevenLabs audio → HeyGen Avatar IV talking clip. Every step auto-feeds the next.

## Launch it (about 10 minutes)

1. Put this folder in a GitHub repo (drag-and-drop upload on github.com works).
2. render.com → **New +** → **Blueprint** → connect the repo → **Apply**. The included `render.yaml` sets up the app, HTTPS, and a persistent 10 GB disk automatically (~$9.50/mo total).
3. You get a URL like `https://render-rail-team.onrender.com`. Open it, create your account, send your friend the link.

Railway also works (Dockerfile included): New Project → Deploy from GitHub → add a Volume mounted at `/var/rail` → Generate Domain.

**Back up** the disk occasionally: `data/` holds accounts, encrypted keys, chats, and character bibles; `outputs/` holds everyone's files. `data/.secret` is the encryption key.

## Cheapest path: one Kie.ai key

Instead of funding OpenAI + xAI + Gemini separately, add a single **Kie.ai** key (kie.ai → sign up → 5,000 free credits, no card → API keys → create). It covers image generation (Nano Banana) and video (Veo, Grok image-to-video) from one pay-as-you-go wallet at roughly 30–80% below direct API rates — Nano Banana images ~$0.02, Veo Fast 8s video ~$0.40. In the clip cards and Images/Video tabs, the engine dropdowns default to **Kie**. HeyGen + ElevenLabs still use their own keys (they run off your existing subscriptions).

## Per-user setup (each person, once)

1. Register → **Settings** → paste your keys: OpenAI (ChatGPT images), Gemini (Nano Banana + Veo), xAI (Grok), HeyGen, ElevenLabs, Anthropic (the Director)
2. **Director → Edit bibles** → your character → upload the master reference image
3. **Voice tab** → pick your ElevenLabs voice (its saved settings are pulled from your account automatically)

Then drop a script in the Director and ⚡ Run. Test with 2 clips before firing 12 — video bills per clip on each user's own accounts.
