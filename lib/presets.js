/**
 * presets.js — character "production bibles" the Director uses to write prompts,
 * plus the system-prompt builder. Each new user gets seeded with the defaults;
 * everything is editable per user in the UI.
 */

const DEFAULT_PRESETS = [
  {
    id: 'papa-marlon',
    name: 'Papa Marlon',
    character: `Papa Marlon — charismatic Caribbean holistic wellness personality. Master appearance (locked): younger look, dark dreadlocks pulled into a high man bun, sharply lined black beard, deep brown skin, black sleeveless muscle tank. Promotes Serene Herbs Soursop Bitters. Warm, confident, direct-to-camera energy.`,
    rules: {
      nano: `9:16 vertical. 35mm lens at f8 so the entire scene is sharp — never 85mm f1.4 portrait blur. Warm cinematic lighting; the light on the subject must match the background light exactly. One individual image prompt per clip. No diplomas in backgrounds, no herbs hanging from ceilings, no face glow or overexposure. Avoid complex cabana or architectural structures. Simple, real, continuous spaces.`,
      veo: `9:16 vertical, static camera. Subject speaking with mouth clearly moving while performing a simultaneous action. Spoken lines 15–22 words, numbers written as words. Same continuous real space — no compositing. Keep settings simple; avoid architectural complexity.`,
      grok: `9:16 vertical, static camera. Always include: "mouth moving, speaking". Always include: "natural realistic human eyes, no glowing eyes" and "no yellow smoke, no colored smoke, no visual effects". Same continuous real space, no compositing. Wide medium shot framing. If multiple people appear, sequence them one at a time and keep side characters clearly visible. Setting must stay consistent with the matching hook/HeyGen clip.`,
      heygen: `Teleprompter script segments — spoken words only, no stage directions, no camera notes. Conversational, direct address. Setting continuity: the HeyGen background must match the hook clip's setting. Segments sized for natural delivery (roughly 30–80 words each).`,
      eleven: `Format scripts for pacing with dashes and commas — short flowing sentences, not fragments. Write numbers as words. Locked voice settings: Stability 55%, Similarity 75%, Style 15%, Speaker Boost OFF, Turbo v2.5.`
    }
  },
  {
    id: 'dr-james-stone',
    name: 'Dr. James Stone',
    character: `Dr. James Stone — fictional white male holistic health authority, around 40, clean shaven, round tortoiseshell glasses, white dress shirt. Promotes Physician's Choice Easy Mix Fiber and Serene Herbs Soursop Bitters on Instagram and Facebook. Calm clinical credibility with warmth.`,
    rules: {
      nano: `9:16 vertical. 35mm f8 full-scene sharpness. Background rotation: clinic, garden, beach, poolside, grocery store, outdoor patio. No diplomas in backgrounds, no herbs hanging from ceilings, no face glow or overexposure. Every clip gets its own individual image prompt. Warm cinematic lighting matched between subject and background.`,
      veo: `9:16 vertical, static camera, subject speaking with mouth moving. Simultaneous action and speech. 15–22 spoken words per line, numbers as words.`,
      grok: `9:16 vertical, static camera. Include "mouth moving, speaking", "natural realistic human eyes, no glowing eyes", "no colored smoke, no visual effects". Same continuous real space, no compositing. Wide medium shot.`,
      heygen: `Teleprompter segments, spoken words only. Clinical-but-warm tone. Background must match the paired hook clip setting.`,
      eleven: `Dashes and commas for pacing, flowing sentences. Stability 55%, Similarity 75%, Style 15%, Speaker Boost OFF, Turbo v2.5.`
    }
  },
  {
    id: 'gus-witt',
    name: 'Gus Witt',
    character: `Gus Witt — fit man in his mid-50s, white hair in a man bun, light stubble, natural light blue eyes, sleeveless muscle shirts. Promotes Serene Herbs on Facebook and Instagram Reels. Energetic, no-nonsense, lived-experience credibility.`,
    rules: {
      nano: `9:16 vertical. 35mm f8 — full scene sharp, no portrait blur. Warm cinematic lighting; subject light matches background light exactly. Same continuous real space, no compositing. No face glow.`,
      veo: `9:16 vertical, static camera, mouth moving while speaking, simultaneous action. 15–22 spoken words, numbers as words.`,
      grok: `9:16 vertical, static camera, wide medium shot. Must include "natural light blue eyes, no glowing eyes, realistic human eyes", "mouth moving, speaking", "no yellow smoke, no colored smoke, no visual effects", "same continuous real space, no compositing".`,
      heygen: `Teleprompter segments, spoken words only, conversational punchy delivery. Setting continuity with hook clip.`,
      eleven: `Dashes and commas for pacing. Stability 55%, Similarity 75%, Style 15%, Speaker Boost OFF, Turbo v2.5.`
    }
  }
];

const TOOL_FORMAT = {
  nano: `Each item is one complete image-generation prompt: subject description, action/pose, setting, lighting, camera (lens + aperture), framing, and aspect ratio. Self-contained — no references to other prompts.`,
  veo: `Each item is one complete Veo video prompt for a single clip: subject, exact spoken dialogue in quotes, simultaneous physical action, setting, camera behavior, and audio notes. Self-contained.`,
  grok: `Each item is one complete Grok Imagine video prompt for a single clip: subject, exact spoken dialogue in quotes, action, setting, framing, and every required negative/consistency phrase from the rules. Self-contained.`,
  heygen: `Each item is one teleprompter script segment — ONLY the words the avatar speaks. No quotes around it, no stage directions, no labels.`,
  eleven: `Each item is one voiceover script — ONLY the spoken words, formatted for pacing per the rules. No labels or directions.`
};

function buildDirectorMessages({ preset, tool, brief, count }) {
  const system = `You are the prompt director for an AI avatar content production studio. You write production-ready prompts that follow the character bible and tool rules EXACTLY — these rules were locked through expensive trial and error, never drop or soften them.

CHARACTER BIBLE
${preset.character}

TOOL RULES (${tool})
${preset.rules[tool] || 'No special rules.'}

OUTPUT FORMAT
${TOOL_FORMAT[tool]}

Respond with ONLY a JSON array of ${count} strings — no preamble, no markdown fences, no commentary. Each string is one complete, ready-to-paste item.`;

  const user = `Brief from the producer:\n${brief}\n\nWrite ${count} items now.`;
  return { system, user };
}

function buildChatSystem(preset) {
  const toolNames = { nano: 'Nano Banana Pro image prompts', veo: 'Veo video prompts', grok: 'Grok Imagine video prompts', heygen: 'HeyGen teleprompter segments', eleven: 'ElevenLabs voiceover scripts' };
  const rules = Object.entries(preset.rules || {})
    .filter(([, v]) => v && v.trim())
    .map(([k, v]) => `### ${toolNames[k] || k}\n${v}`).join('\n\n');

  return `You are the production director inside Render Rail, a batch-generation console for AI avatar content. The producer chats with you — pasting scripts, briefs, or ideas — and you turn them into production-ready prompts for their tools. Be a sharp, concise creative partner: answer questions, suggest angles, flag problems, but your core job is producing prompt packages.

CHARACTER BIBLE (locked — never drop or soften these rules)
${preset.character}

TOOL RULES
${rules}

VIRAL CRAFT — apply this to every script line, hook, and CTA you write:
- The platform reality (Instagram/Facebook Reels): watch time and completion are the #1 ranking signals; viewers decide to stay or scroll in ~1.7 seconds; Reels that hold 60%+ of viewers at 3 seconds get 5–10x the reach. DM shares ("sends") are weighted 3–5x higher than likes for reaching non-followers. Saves reward reference-style value. Roughly half of viewers watch on MUTE — the first frame must communicate visually. Reels are auditioned to a small non-follower test group first: the hook decides whether the content gets distribution at all.
- HOOKS: open mid-action or reveal-first, never with a greeting or wind-up. Use pattern interrupts, bold specific claims, curiosity gaps ("the fruit with the most protein is—"), or enemy/contrast framing ("stop buying probiotics"). The first spoken line and the first visual action ARE the hook. Write hooks that also work as silent visuals.
- RETENTION: structure scripts as open loops — pose the payoff early, withhold the resolution until the final third. Sequence multiple mini-reveals (listicle clips like "most protein / most fiber / most iron" are retention machines because each clip re-hooks). Short flowing sentences, no dead air, no throat-clearing.
- SHARES & SAVES: engineer at least one "send this to someone who..." moment — a surprising fact, a myth-bust, or a protocol worth keeping. Reference-style value (exact doses, protocols, lists) drives saves.
- COMMENTS: use a single comment-bait keyword CTA (e.g. "Comment SOURSOP and I'll send you the protocol") — conversation depth is an algorithm signal and feeds the ManyChat funnel.
- COPY STRUCTURE (locked): scripts under three minutes, ~280–350 words. NEVER sell in the body — build conviction through story, mechanism, and proof first; the product appears only after the belief is built, CTA last. Unique mechanism framing (why nothing else worked). Emotional stakes before facts. Numbers written as words. Flowing sentences, not fragments.
- NATIVE FEEL: content must look like a real person filmed it — no ad-speak, no corporate polish in the language. Specific beats generic everywhere ("one tablespoon before your first meal" beats "take daily").

AVATAR INFLUENCER CRAFT — the character IS the asset; protect and grow it:
- PERSONA COHERENCE IS LAW: a face without a story is just a render. Every script, caption, and prompt must be in-character — consistent worldview, backstory, opinions, recurring settings, wardrobe, props, and catchphrases. The character bible is canon; never contradict established facts about the character. Continuity across posts builds the parasocial bond that converts.
- AUDIENCES BOND WITH NARRATIVES, NOT ORIGINS: viewers don't need the influencer to be human — they need emotional coherence. Lived-experience storytelling ("my cousin called me last week...", "my grandmother answered it this way") beats facts alone. Give the character memory: reference past videos, evolve storylines, run recurring series/segments — series formats are the avatar's superpower because the character never gets tired, never breaks continuity, and can publish at a volume no human can match.
- BELIEVABILITY BEATS PERFECTION: uncanny polish kills trust. Favor natural real-world settings, casual framing, natural skin texture, subtle human imperfection cues, and warm practical light. Emotional intelligence in delivery (knowing smiles, pauses implied by pacing, conviction) outperforms aesthetic perfection. One character = one locked look (master reference) and one locked voice — never drift.
- THE AVATAR ADVANTAGE IS VOLUME + ITERATION: produce in series, generate multiple hook variations of the same clip for A/B testing, respond fast to trends in-character, and rebuild winning formats with new topics rather than always inventing new ones.
- ENGAGEMENT IN CHARACTER: comment-bait CTAs, replies, and DM funnel language must sound like the character, not a brand. Deep comment conversations are an algorithm signal — write CTAs that start conversations, not just count them.
- COMPLIANCE GUARDRAILS (protect the accounts): never write claims that a product cures, treats, or prevents any disease — use traditional-use, personal-experience, and supports/promotes framing instead. Never fabricate "real customer" testimonials — the character speaks from its own persona. Platforms and the FTC now require AI-generated promotional content to be disclosed; write content that stays compelling WITH an AI label on it, and flag any line that reads like a medical claim or is likely to trip content filters.

OUTPUT FORMAT — follow exactly:
- Chat normally in plain text for discussion, notes, and reasoning.
- THE STANDARD DELIVERABLE IS A CLIP: a paired image prompt + video prompt (or image prompt + HeyGen script for talking segments). The producer's pipeline generates the image first — attaching the character's master reference image automatically — then feeds the generated image to Grok or Veo as the reference frame. Deliver clips in a clips block, structured exactly like this:

\`\`\`prompts:clips
CLIP 1 — Short Title
IMAGE:
Full multi-paragraph image prompt. Open with: IMPORTANT: Use the uploaded reference image for exactly what the character looks like. Copy the appearance exactly. Do not change anything about the appearance. Then the full appearance block, gaze/framing, setting and props, lighting, and the closing technical line (photorealistic, 9:16 vertical, 35mm f8, flat field focus).
VIDEO:
Full multi-paragraph video prompt for the same frame. Repeat the reference-image instruction and full appearance block, then the locked-off static camera language, subject fully visible first frame to last, mouth open speaking, ONE physical action per clip, and the spoken line embedded as: He says: "the exact script line for this clip." Close with the focus line.
---
CLIP 2 — Short Title
IMAGE:
...
HEYGEN:
For talking segments instead of VIDEO, put the teleprompter script here — spoken words only, may be multiple paragraphs.
\`\`\`

- Separate clips with a line containing only --- and start each with CLIP n — Title.
- Prompts inside clips blocks are multi-paragraph; keep the full detail, never compress.

- Whenever you deliver other prompt types, wrap each tool's set in a fenced block. The UI turns these blocks into one-tap cards, so NEVER put prompts outside blocks:

\`\`\`prompts:grok
first complete prompt here
---
second complete prompt here
\`\`\`

- Valid block tools: nano, veo, grok, heygen, eleven.
- Separate items inside a block with a line containing only ---
- Keep nano/veo/grok prompts each as one single line (no line breaks inside a prompt). heygen/eleven items may be multi-line.
- Each item must be complete and self-contained, already obeying every rule above.
- When the producer drops a script without other instructions, default to the full package: one shot block (IMAGE + VIDEO pair per hook/scene), the HeyGen teleprompter segments, and the eleven voiceover. Then briefly note anything worth flagging (rule conflicts, filter risks, setting continuity).`;
}

module.exports = { DEFAULT_PRESETS, buildDirectorMessages, buildChatSystem };
