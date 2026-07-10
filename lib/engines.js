/**
 * engines.js — the five generation engines + catalog fetchers.
 * Every runner receives (job, keys) where keys are the *owning user's* decrypted keys,
 * writes the output file, and sets job.file / job.kind. Throws on failure.
 */

const fs = require('fs');
const path = require('path');

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const XAI_BASE = 'https://api.x.ai/v1';
const HEYGEN_BASE = 'https://api.heygen.com';
const ELEVEN_BASE = 'https://api.elevenlabs.io/v1';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJson(url, opts, label) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const detail = data?.error?.message || data?.message || (typeof data?.error === 'string' ? data.error : '') || text.slice(0, 300);
    const e = new Error(`${label} ${res.status}: ${detail}`);
    e.status = res.status;
    throw e;
  }
  return data;
}

async function downloadTo(url, headers, absPath, label) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${label} download ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 500) throw new Error(`${label} download looks empty (${buf.length} bytes)`);
  fs.writeFileSync(absPath, buf);
}

// ------------------------------------------------------------------ nano (image)

async function runNano(job, keys, out, resolveRef) {
  if (!keys.gemini) throw new Error('No Gemini API key connected — open Settings.');
  const url = `${GEMINI_BASE}/models/${job.model}:generateContent`;
  const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': keys.gemini };
  const reqParts = [];
  if (job.refImage && resolveRef) {
    // character master reference — the model copies the appearance from this
    const { b64, mime } = readImage(resolveRef(job.refImage));
    reqParts.push({ inlineData: { mimeType: mime, data: b64 } });
  }
  reqParts.push({ text: job.prompt });
  const makeBody = withAspect => JSON.stringify({
    contents: [{ parts: reqParts }],
    generationConfig: {
      responseModalities: ['IMAGE'],
      ...(withAspect && job.aspectRatio ? { imageConfig: { aspectRatio: job.aspectRatio } } : {})
    }
  });

  let data;
  try {
    data = await fetchJson(url, { method: 'POST', headers, body: makeBody(true) }, 'Gemini image');
  } catch (err) {
    if (err.status === 400) data = await fetchJson(url, { method: 'POST', headers, body: makeBody(false) }, 'Gemini image');
    else throw err;
  }
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const img = parts.find(p => p.inlineData?.data);
  if (!img) {
    const block = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason;
    throw new Error(`No image returned${block ? ` (${block})` : ''} — prompt may have been filtered.`);
  }
  const ext = /png/i.test(img.inlineData.mimeType || '') ? 'png' : 'jpg';
  const p = out(ext);
  fs.writeFileSync(p.abs, Buffer.from(img.inlineData.data, 'base64'));
  job.file = p.rel; job.kind = 'image';
}

// ------------------------------------------------------------------ gpt image (ChatGPT image gen)

function gptSize(aspect) {
  if (aspect === '16:9') return '1536x1024';
  if (aspect === '1:1') return '1024x1024';
  return '1024x1536'; // 9:16 portrait
}

async function runGptImage(job, keys, out, resolveRef) {
  if (!keys.openai) throw new Error('No OpenAI API key connected — open Settings.');
  const model = job.model || 'gpt-image-1';
  const size = gptSize(job.aspectRatio);
  let data;
  if (job.refImage && resolveRef) {
    // reference-guided generation via images/edits — this is the "use the uploaded reference image" flow
    const abs = resolveRef(job.refImage);
    const { mime } = readImage(abs);
    const form = new FormData();
    form.append('model', model);
    form.append('prompt', job.prompt.slice(0, 32000));
    form.append('size', size);
    form.append('image[]', new Blob([fs.readFileSync(abs)], { type: mime }), 'reference.' + (mime.includes('png') ? 'png' : 'jpg'));
    const res = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${keys.openai}` },
      body: form
    });
    const text = await res.text();
    try { data = JSON.parse(text); } catch { data = {}; }
    if (!res.ok) throw new Error(`ChatGPT image ${res.status}: ${(data?.error?.message || text).slice(0, 250)}`);
  } else {
    data = await fetchJson('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${keys.openai}` },
      body: JSON.stringify({ model, prompt: job.prompt.slice(0, 32000), size })
    }, 'ChatGPT image');
  }
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) throw new Error('ChatGPT image returned no image — prompt may have been rejected.');
  const p = out('png');
  fs.writeFileSync(p.abs, Buffer.from(b64, 'base64'));
  job.file = p.rel; job.kind = 'image';
}

// ------------------------------------------------------------------ kie.ai (unified gateway)
// One key → images (Nano Banana), video (Veo, Grok img2video), all via createTask + poll.

const KIE_BASE = 'https://api.kie.ai/api/v1';

async function kieUploadImage(kkey, absPath) {
  // Kie needs a public URL for reference images; use its file upload (base64) endpoint
  const { b64, mime } = readImage(absPath);
  const data = await fetchJson(`${KIE_BASE}/file/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${kkey}` },
    body: JSON.stringify({ file: `data:${mime};base64,${b64}`, fileName: 'ref.' + (mime.includes('png') ? 'png' : 'jpg') })
  }, 'Kie upload').catch(() => null);
  return data?.data?.url || data?.data?.fileUrl || data?.url || null;
}

async function kieCreateAndPoll(kkey, model, input, { label, timeoutMin = 15 }) {
  const start = await fetchJson(`${KIE_BASE}/jobs/createTask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${kkey}` },
    body: JSON.stringify({ model, input })
  }, `${label} start`);
  const taskId = start.data?.taskId || start.data?.task_id || start.taskId;
  if (!taskId) throw new Error(`${label}: no taskId returned (${JSON.stringify(start).slice(0,150)})`);

  const deadline = Date.now() + timeoutMin * 60 * 1000;
  while (true) {
    if (Date.now() > deadline) throw new Error(`${label} timeout after ${timeoutMin} min.`);
    await sleep(6000);
    const rec = await fetchJson(`${KIE_BASE}/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`,
      { headers: { 'Authorization': `Bearer ${kkey}` } }, `${label} poll`);
    const d = rec.data || rec;
    const state = String(d.state || d.status || '').toLowerCase();
    if (state === 'success' || state === 'completed' || state === 'succeeded') {
      let out = d.resultJson || d.result || d.output || d.resultUrls;
      if (typeof out === 'string') { try { out = JSON.parse(out); } catch {} }
      const urls = out?.resultUrls || out?.result_urls || out?.urls || out?.images || out?.videos
        || (out?.url ? [out.url] : null) || (Array.isArray(out) ? out : null);
      const url = Array.isArray(urls) ? urls[0] : urls;
      if (!url) throw new Error(`${label} finished but no output URL.`);
      return typeof url === 'string' ? url : (url.url || url.resultUrl);
    }
    if (state === 'fail' || state === 'failed' || state === 'error') {
      throw new Error(`${label} failed: ${d.failMsg || d.failCode || d.error || 'unknown'}`);
    }
  }
}

const KIE_RATIO = a => (a === '16:9' ? '16:9' : a === '1:1' ? '1:1' : '9:16');

async function runKieImage(job, keys, out, resolveRef) {
  const kkey = keys.kieImage || keys.kie; // per-tool override, falls back to the main key
  if (!kkey) throw new Error('No Kie.ai API key connected — open Settings.');
  const model = job.model || 'google/nano-banana';
  const input = { prompt: job.prompt, output_format: 'png', image_size: KIE_RATIO(job.aspectRatio) };
  if (job.refImage && resolveRef) {
    const url = await kieUploadImage(kkey, resolveRef(job.refImage));
    if (url) { input.image_urls = [url]; } // reference/edit mode
  }
  const url = await kieCreateAndPoll(kkey, model, input, { label: 'Kie image', timeoutMin: 8 });
  const p = out('png');
  await downloadTo(url, {}, p.abs, 'Kie image');
  job.file = p.rel; job.kind = 'image';
}

async function runKieVideo(job, keys, out, onPolling, resolveImage) {
  const kkey = keys.kieVideo || keys.kie; // per-tool override, falls back to the main key
  if (!kkey) throw new Error('No Kie.ai API key connected — open Settings.');
  const model = job.model || 'veo3_fast';
  let imgUrl = null;
  if (job.imageFile && resolveImage) imgUrl = await kieUploadImage(kkey, resolveImage(job.imageFile));

  let url;
  if (/^veo/i.test(model)) {
    // Veo has its own dedicated endpoints on Kie (per docs.kie.ai/veo3-api)
    const body = { prompt: job.prompt, model: model.replace('veo3-fast', 'veo3_fast'), aspectRatio: KIE_RATIO(job.aspectRatio) };
    if (imgUrl) body.imageUrls = [imgUrl];
    const start = await fetchJson(`${KIE_BASE}/veo/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${kkey}` },
      body: JSON.stringify(body)
    }, 'Kie Veo start');
    const taskId = start.data?.taskId || start.taskId;
    if (!taskId) throw new Error(`Kie Veo: no taskId (${JSON.stringify(start).slice(0,150)})`);
    onPolling(taskId);
    const deadline = Date.now() + 25 * 60 * 1000;
    while (true) {
      if (Date.now() > deadline) throw new Error('Kie Veo timeout after 25 min.');
      await sleep(8000);
      const rec = await fetchJson(`${KIE_BASE}/veo/record-info?taskId=${encodeURIComponent(taskId)}`,
        { headers: { 'Authorization': `Bearer ${kkey}` } }, 'Kie Veo poll');
      const d = rec.data || rec;
      const flag = Number(d.successFlag);
      if (flag === 1) {
        let resp = d.response || d.resultInfoJson || d.result;
        if (typeof resp === 'string') { try { resp = JSON.parse(resp); } catch {} }
        const urls = resp?.resultUrls || resp?.result_urls || d.resultUrls;
        url = Array.isArray(urls) ? urls[0] : urls;
        if (!url) throw new Error('Kie Veo finished but no result URL.');
        break;
      }
      if (flag === 2 || flag === 3) throw new Error(`Kie Veo failed: ${d.errorMessage || d.failMsg || 'generation failed'}`);
    }
  } else {
    // everything else (Grok Imagine, Kling, Seedance…) uses the Market createTask pattern
    const input = { prompt: job.prompt, aspect_ratio: KIE_RATIO(job.aspectRatio) };
    if (job.duration) input.duration = Number(job.duration);
    if (imgUrl) input.image_urls = [imgUrl];
    url = await kieCreateAndPoll(kkey, model, input, { label: 'Kie video', timeoutMin: 20 });
  }
  const p = out('mp4');
  await downloadTo(url, {}, p.abs, 'Kie video');
  job.file = p.rel; job.kind = 'video';
}

// ------------------------------------------------------------------ veo (video)

function readImage(absPath) {
  const b = fs.readFileSync(absPath);
  const mime = /\.png$/i.test(absPath) ? 'image/png' : /\.webp$/i.test(absPath) ? 'image/webp' : 'image/jpeg';
  return { b64: b.toString('base64'), mime };
}

async function runVeo(job, keys, out, onPolling, resolveImage) {
  if (!keys.gemini) throw new Error('No Gemini API key connected — open Settings.');
  const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': keys.gemini };
  const params = {};
  if (job.aspectRatio) params.aspectRatio = job.aspectRatio;
  if (job.resolution) params.resolution = job.resolution;

  const instance = { prompt: job.prompt };
  if (job.imageFile && resolveImage) {
    const { b64, mime } = readImage(resolveImage(job.imageFile));
    instance.image = { bytesBase64Encoded: b64, mimeType: mime };
  }
  let start;
  try {
    start = await fetchJson(`${GEMINI_BASE}/models/${job.model}:predictLongRunning`,
      { method: 'POST', headers, body: JSON.stringify({ instances: [instance], parameters: params }) }, 'Veo start');
  } catch (err) {
    // some API versions name the field imageBytes instead
    if (instance.image && err.status === 400) {
      const { b64, mime } = readImage(resolveImage(job.imageFile));
      instance.image = { imageBytes: b64, mimeType: mime };
      start = await fetchJson(`${GEMINI_BASE}/models/${job.model}:predictLongRunning`,
        { method: 'POST', headers, body: JSON.stringify({ instances: [instance], parameters: params }) }, 'Veo start');
    } else throw err;
  }
  if (!start.name) throw new Error('Veo did not return an operation name.');
  onPolling(start.name);

  const deadline = Date.now() + 15 * 60 * 1000;
  let op = start;
  while (!op.done) {
    if (Date.now() > deadline) throw new Error('Veo timeout after 15 minutes.');
    await sleep(10000);
    op = await fetchJson(`${GEMINI_BASE}/${start.name}`, { headers }, 'Veo poll');
  }
  if (op.error) throw new Error(`Veo: ${op.error.message || JSON.stringify(op.error)}`);
  const resp = op.response || {};
  const vid = resp.generateVideoResponse?.generatedSamples?.[0]?.video || resp.generatedVideos?.[0]?.video || resp.videos?.[0];
  const uri = vid?.uri || vid?.url;
  if (!uri) {
    const filtered = resp.generateVideoResponse?.raiMediaFilteredReasons?.join('; ');
    throw new Error(filtered ? `Veo filtered the output: ${filtered}` : 'Veo finished but returned no video.');
  }
  const p = out('mp4');
  await downloadTo(uri, { 'x-goog-api-key': keys.gemini }, p.abs, 'Veo');
  job.file = p.rel; job.kind = 'video';
}

// ------------------------------------------------------------------ grok (video)

async function runGrok(job, keys, out, onPolling, resolveImage) {
  if (!keys.xai) throw new Error('No xAI API key connected — open Settings.');
  const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${keys.xai}` };
  const body = { model: job.model, prompt: job.prompt };
  if (job.duration) body.duration = Number(job.duration);
  if (job.aspectRatio) body.aspect_ratio = job.aspectRatio;
  if (job.resolution) body.resolution = job.resolution;
  if (job.imageFile && resolveImage) {
    const { b64, mime } = readImage(resolveImage(job.imageFile));
    body.image_url = `data:${mime};base64,${b64}`; // image-to-video reference
  }

  const start = await fetchJson(`${XAI_BASE}/videos/generations`, { method: 'POST', headers, body: JSON.stringify(body) }, 'Grok start');
  const reqId = start.request_id || start.id;
  if (!reqId) throw new Error('Grok did not return a request_id.');
  onPolling(reqId);

  const deadline = Date.now() + 15 * 60 * 1000;
  while (true) {
    if (Date.now() > deadline) throw new Error('Grok timeout after 15 minutes.');
    await sleep(5000);
    const st = await fetchJson(`${XAI_BASE}/videos/${reqId}`, { headers: { Authorization: headers.Authorization } }, 'Grok poll');
    if (st.status === 'done') {
      const url = st.video?.url;
      if (!url) throw new Error('Grok finished but returned no video URL.');
      const p = out('mp4');
      await downloadTo(url, {}, p.abs, 'Grok'); // temporary URL — grab immediately
      job.file = p.rel; job.kind = 'video';
      return;
    }
    if (st.status === 'failed' || st.status === 'expired') {
      throw new Error(`Grok generation ${st.status}${st.error ? ': ' + JSON.stringify(st.error) : ''}`);
    }
  }
}

// ------------------------------------------------------------------ heygen (avatar video)

function heygenDims(aspect) {
  if (aspect === '16:9') return { width: 1280, height: 720 };
  if (aspect === '1:1') return { width: 1080, height: 1080 };
  return { width: 720, height: 1280 }; // 9:16 default
}

async function runHeygen(job, keys, out, onPolling) {
  if (!keys.heygen) throw new Error('No HeyGen API key connected — open Settings.');
  if (!job.avatarId) throw new Error('No avatar selected — pick one on the HeyGen tab.');
  if (!job.voiceId) throw new Error('No voice selected — pick one on the HeyGen tab.');
  const headers = { 'Content-Type': 'application/json', 'X-Api-Key': keys.heygen };
  const dim = heygenDims(job.aspectRatio);

  let videoId, useV3 = true;
  try {
    // current v3 API
    const start = await fetchJson(`${HEYGEN_BASE}/v3/videos`, {
      method: 'POST', headers,
      body: JSON.stringify({
        type: 'avatar',
        avatar_id: job.avatarId,
        voice_id: job.voiceId,
        script: job.prompt,
        engine: { type: 'avatar_v' },
        dimension: dim
      })
    }, 'HeyGen start');
    videoId = start.data?.id || start.data?.video_id || start.id;
  } catch (err) {
    if (err.status !== 404 && err.status !== 400 && err.status !== 405) throw err;
    // legacy v2 fallback (supported until Oct 2026)
    useV3 = false;
    const start = await fetchJson(`${HEYGEN_BASE}/v2/video/generate`, {
      method: 'POST', headers,
      body: JSON.stringify({
        video_inputs: [{
          character: { type: 'avatar', avatar_id: job.avatarId, avatar_style: 'normal' },
          voice: { type: 'text', input_text: job.prompt, voice_id: job.voiceId }
        }],
        dimension: dim
      })
    }, 'HeyGen start (v2)');
    videoId = start.data?.video_id;
  }
  if (!videoId) throw new Error('HeyGen did not return a video id.');
  onPolling(videoId);

  const deadline = Date.now() + 30 * 60 * 1000; // avatar renders can be slow
  while (true) {
    if (Date.now() > deadline) throw new Error('HeyGen timeout after 30 minutes.');
    await sleep(10000);
    let st;
    if (useV3) {
      st = await fetchJson(`${HEYGEN_BASE}/v3/videos/${videoId}`, { headers: { 'X-Api-Key': keys.heygen } }, 'HeyGen poll');
    } else {
      st = await fetchJson(`${HEYGEN_BASE}/v1/video_status.get?video_id=${videoId}`, { headers: { 'X-Api-Key': keys.heygen } }, 'HeyGen poll');
    }
    const d = st.data || st;
    if (d.status === 'completed') {
      if (!d.video_url) throw new Error('HeyGen completed but returned no video_url.');
      const p = out('mp4');
      await downloadTo(d.video_url, {}, p.abs, 'HeyGen'); // signed URL expires — grab immediately
      job.file = p.rel; job.kind = 'video';
      return;
    }
    if (d.status === 'failed') {
      throw new Error(`HeyGen failed: ${d.failure_message || d.error?.message || d.failure_code || 'unknown error'}`);
    }
  }
}

// ------------------------------------------------------------------ heygen avatar iv (animate a generated still)

async function uploadHeygenAsset(keys, absPath, contentType) {
  const up = await fetch('https://upload.heygen.com/v1/asset', {
    method: 'POST',
    headers: { 'X-Api-Key': keys.heygen, 'Content-Type': contentType },
    body: fs.readFileSync(absPath)
  });
  const text = await up.text();
  let data; try { data = JSON.parse(text); } catch { data = {}; }
  if (!up.ok) throw new Error(`HeyGen asset upload ${up.status}: ${(data?.error?.message || text).slice(0, 200)}`);
  return {
    key: data?.data?.image_key || data?.data?.audio_key || data?.data?.key || data?.data?.id,
    assetId: data?.data?.id,
    url: data?.data?.url
  };
}

async function runHeygenAv4(job, keys, out, onPolling, resolveImage) {
  if (!keys.heygen) throw new Error('No HeyGen API key connected — open Settings.');
  if (!job.imageFile) throw new Error('Avatar IV needs the generated image — missing imageFile.');
  if (!job.audioFile && !job.voiceId) throw new Error('Avatar IV needs the ElevenLabs audio or a HeyGen voice pick.');

  // 1. upload the generated still (and the ElevenLabs audio, if this clip has one)
  const absImg = resolveImage(job.imageFile);
  const img = await uploadHeygenAsset(keys, absImg, readImage(absImg).mime);
  if (!img.key) throw new Error('HeyGen asset upload returned no image_key.');
  let audio = null;
  if (job.audioFile) {
    audio = await uploadHeygenAsset(keys, resolveImage(job.audioFile), 'audio/mpeg');
    if (!audio.assetId && !audio.url) throw new Error('HeyGen audio upload returned no asset id.');
  }

  // 2. create the Avatar IV video: the still speaks the ElevenLabs audio (or script+voice fallback)
  const headers = { 'Content-Type': 'application/json', 'X-Api-Key': keys.heygen };
  const title = `${job.batchSlug} ${String(job.index).padStart(3, '0')}`.slice(0, 80);
  const makeBody = (withDim, audioField) => JSON.stringify({
    image_key: img.key,
    video_title: title,
    ...(audio
      ? (audioField === 'url' ? { audio_url: audio.url } : { audio_asset_id: audio.assetId })
      : { script: job.prompt, voice_id: job.voiceId }),
    ...(withDim ? { dimension: heygenDims(job.aspectRatio) } : {})
  });
  let start;
  const attempts = audio
    ? [[true, 'asset'], [true, 'url'], [false, 'asset'], [false, 'url']]
    : [[true, null], [false, null]];
  let lastErr;
  for (const [withDim, audioField] of attempts) {
    try {
      start = await fetchJson(`${HEYGEN_BASE}/v2/video/av4/generate`, { method: 'POST', headers, body: makeBody(withDim, audioField) }, 'HeyGen AvatarIV start');
      break;
    } catch (err) {
      lastErr = err;
      if (err.status !== 400) throw err; // only param-shape retries on 400
    }
  }
  if (!start) throw lastErr;
  const videoId = start.data?.video_id || start.data?.id;
  if (!videoId) throw new Error('HeyGen Avatar IV did not return a video id.');
  onPolling(videoId);

  // 3. poll until rendered, then save immediately (signed URLs expire)
  const deadline = Date.now() + 30 * 60 * 1000;
  while (true) {
    if (Date.now() > deadline) throw new Error('HeyGen Avatar IV timeout after 30 minutes.');
    await sleep(10000);
    let st;
    try {
      st = await fetchJson(`${HEYGEN_BASE}/v1/video_status.get?video_id=${videoId}`, { headers: { 'X-Api-Key': keys.heygen } }, 'HeyGen AvatarIV poll');
    } catch (err) {
      if (err.status === 404) st = await fetchJson(`${HEYGEN_BASE}/v3/videos/${videoId}`, { headers: { 'X-Api-Key': keys.heygen } }, 'HeyGen AvatarIV poll');
      else throw err;
    }
    const d = st.data || st;
    if (d.status === 'completed') {
      if (!d.video_url) throw new Error('HeyGen Avatar IV completed but returned no video_url.');
      const p = out('mp4');
      await downloadTo(d.video_url, {}, p.abs, 'HeyGen AvatarIV');
      job.file = p.rel; job.kind = 'video';
      return;
    }
    if (d.status === 'failed') throw new Error(`HeyGen Avatar IV failed: ${d.failure_message || d.error?.message || d.failure_code || 'unknown error'}`);
  }
}

// ------------------------------------------------------------------ eleven (voice)

async function runEleven(job, keys, out) {
  if (!keys.eleven) throw new Error('No ElevenLabs API key connected — open Settings.');
  if (!job.voiceId) throw new Error('No voice selected — pick one on the Voice tab.');
  const vs = job.voiceSettings || {};
  const res = await fetch(`${ELEVEN_BASE}/text-to-speech/${job.voiceId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'xi-api-key': keys.eleven },
    body: JSON.stringify({
      text: job.prompt,
      model_id: job.model || 'eleven_turbo_v2_5',
      voice_settings: {
        stability: vs.stability ?? 0.55,
        similarity_boost: vs.similarity ?? 0.75,
        style: vs.style ?? 0.15,
        use_speaker_boost: vs.speakerBoost ?? false
      }
    })
  });
  if (!res.ok) {
    const text = await res.text();
    let msg = text.slice(0, 300);
    try { msg = JSON.parse(text)?.detail?.message || msg; } catch {}
    throw new Error(`ElevenLabs ${res.status}: ${msg}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 500) throw new Error('ElevenLabs returned empty audio.');
  const p = out('mp3');
  fs.writeFileSync(p.abs, buf);
  job.file = p.rel; job.kind = 'audio';
}

// ------------------------------------------------------------------ catalogs (populate UI dropdowns)

async function heygenCatalog(keys) {
  if (!keys.heygen) throw new Error('No HeyGen API key connected.');
  const headers = { 'X-Api-Key': keys.heygen, 'Accept': 'application/json' };
  const [av, vo] = await Promise.all([
    fetchJson(`${HEYGEN_BASE}/v2/avatars`, { headers }, 'HeyGen avatars'),
    fetchJson(`${HEYGEN_BASE}/v2/voices`, { headers }, 'HeyGen voices')
  ]);
  const avatars = (av.data?.avatars || []).map(a => ({ id: a.avatar_id, name: a.avatar_name || a.avatar_id, preview: a.preview_image_url || '' }));
  const talkingPhotos = (av.data?.talking_photos || []).map(a => ({ id: a.talking_photo_id, name: (a.talking_photo_name || a.talking_photo_id) + ' (photo)', preview: a.preview_image_url || '' }));
  const voices = (vo.data?.voices || []).map(v => ({ id: v.voice_id, name: `${v.name || v.voice_id}${v.language ? ' · ' + v.language : ''}` }));
  return { avatars: [...avatars, ...talkingPhotos].slice(0, 400), voices: voices.slice(0, 400) };
}

async function elevenVoiceSettings(keys, voiceId) {
  const d = await fetchJson(`${ELEVEN_BASE}/voices/${voiceId}/settings`, { headers: { 'xi-api-key': keys.eleven } }, 'ElevenLabs voice settings');
  return {
    stability: typeof d.stability === 'number' ? d.stability : 0.55,
    similarity: typeof d.similarity_boost === 'number' ? d.similarity_boost : 0.75,
    style: typeof d.style === 'number' ? d.style : 0.15,
    speakerBoost: !!d.use_speaker_boost
  };
}

async function elevenCatalog(keys) {
  if (!keys.eleven) throw new Error('No ElevenLabs API key connected.');
  const data = await fetchJson(`${ELEVEN_BASE}/voices`, { headers: { 'xi-api-key': keys.eleven } }, 'ElevenLabs voices');
  return { voices: (data.voices || []).map(v => ({ id: v.voice_id, name: `${v.name}${v.category ? ' · ' + v.category : ''}` })) };
}

// ------------------------------------------------------------------ director (Claude prompt generation)

async function runDirector({ keys, system, user, maxTokens = 4000 }) {
  if (!keys.anthropic) throw new Error('No Anthropic API key connected — open Settings.');
  const data = await fetchJson('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': keys.anthropic,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }]
    })
  }, 'Claude');
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  // strict JSON array expected; strip fences if the model added them
  const clean = text.replace(/```json|```/g, '').trim();
  const first = clean.indexOf('['), last = clean.lastIndexOf(']');
  if (first === -1 || last === -1) throw new Error('Claude did not return a prompt list — try again.');
  const arr = JSON.parse(clean.slice(first, last + 1));
  if (!Array.isArray(arr) || !arr.length) throw new Error('Claude returned an empty list.');
  return arr.map(String);
}

async function runChat({ keys, system, messages, model }) {
  const mdl = model || 'claude-sonnet-4-6';
  const body = { model: mdl, max_tokens: 16000, system, messages };
  let data;
  if (keys.anthropic) {
    // direct Anthropic
    data = await fetchJson('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': keys.anthropic, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body)
    }, 'Claude');
  } else {
    // fall back to Kie's Claude proxy — same schema, billed from the Kie wallet
    const kkey = keys.kie || keys.kieImage || keys.kieVideo;
    if (!kkey) throw new Error('The Director needs an Anthropic key or a Kie.ai key — open Settings.');
    const call = b => fetchJson('https://api.kie.ai/claude/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${kkey}` },
      body: JSON.stringify(b)
    }, 'Claude via Kie');
    try {
      data = await call(body);
    } catch (err) {
      if (err.status === 400 && system) {
        // safety: if the proxy rejects top-level system, fold it into the first message
        const merged = [{ role: 'user', content: `${system}\n\n---\n\n${messages[0]?.content || ''}` }, ...messages.slice(1)];
        data = await call({ model: mdl, max_tokens: 16000, messages: merged });
      } else throw err;
    }
  }
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  if (!text.trim()) throw new Error('Claude returned an empty reply — try again.');
  return text;
}

module.exports = { runNano, runGptImage, runKieImage, runKieVideo, runVeo, runGrok, runHeygen, runHeygenAv4, runEleven, heygenCatalog, elevenCatalog, elevenVoiceSettings, runDirector, runChat };
