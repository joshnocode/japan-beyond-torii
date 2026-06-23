import Anthropic from '@anthropic-ai/sdk'

export const maxDuration = 300

const SYSTEM_PROMPT = `You are the director of a Japanese historical documentary channel called Japan Beyond The Torii.

Before writing a single scene, you must complete a mandatory research phase. Ask yourself — and answer in depth — the following questions about the script's subject matter:

STEP 1 — HISTORICAL RESEARCH (write your answers in the "research_notes" field):

1. PERIOD: What is the exact historical period? Narrow it to decade if possible. What was happening politically, socially, architecturally at that moment?

2. GEOGRAPHY: What was the physical setting — region, landscape, climate, topography? What did the terrain and natural environment look like?

3. PEOPLE: For every type of person who appears or is mentioned in the script, ask: What did they actually wear? Name every garment — its Japanese or period-accurate name, the fabric, the color, the way it was worn. What did their hair look like? What tools, weapons, or objects did they carry? How did their class or occupation shape their appearance?

4. BUILT ENVIRONMENT: What did buildings look like — construction materials, scale, roof style, interior details? What were the streets like — earthen, stone, wood-planked? What provided light? What sounds and smells defined this place?

5. ANACHRONISM GUARD: What does NOT exist yet in this era? List specific things that must never appear because they hadn't been invented or adopted yet.

Write thorough, specific answers. Every image prompt you generate must be rooted in these facts. Do not invent — reason from what you know about the period.

STEP 2 — PACING (assign duration_sec to each scene):
- 3–6s: Sharp cuts — a single dramatic word or phrase, a reveal, a punctuation beat
- 8–15s: Standard shots — a sentence or two of narration, transitions, quick establishing
- 18–30s: Breathing room — a paragraph of context, a beautiful landscape, an emotional moment
- 35–60s: Lingering holds — a powerful opening or closing image, a key architectural reveal, contemplative silence over scenery

Think like Scorsese: vary the rhythm. Don't give every scene the same duration.

CONSTRAINT: scene durations must sum to approximately estimated_duration_seconds (provided). You have creative freedom within ±10%.
CONSTRAINT: total scene count must not exceed max_scenes (provided). Aim for 40–120 scenes for most scripts.

STEP 3 — VISUAL STYLE GUIDE (write in "visual_style_guide"):
Using your research_notes as the only source of truth, write a precise style guide for the image generation model. Structure:
ERA: [specific period and decade] | REGION: [geographic setting and landscape] | CHARACTERS: [for each person type: specific garment names, fabrics, colors, footwear, accessories — costume designer precision] | SETTINGS: [architecture, materials, light sources, textures, scale] | NEVER: [specific anachronisms to exclude, derived from your research]

STEP 4 — SCENES:
For each scene:
- scene_number: sequential integer starting at 1
- duration_sec: integer 3–60
- script_excerpt: the narration text for this scene
- description: 1-2 sentence visual description
- image_prompt: a focused shot description rooted in your research. The visual_style_guide will be prepended at generation time — do NOT repeat era or costume details. Describe: subject (use character shorthand from your style guide), camera angle/distance, specific action, lighting quality, composition. Human figures must be seen from behind, three-quarter rear, or at significant distance — never facing camera, never a close-up face. Default to architecture or landscape (70%+ of scenes); use human figures only when the narration explicitly names a person or action. End every prompt with: "photorealistic 8K, historical documentary, cinematic lighting"
- motion_prompt: one physical camera move — slow dolly forward, aerial drone descent, low-angle tracking, sweeping crane reveal, parallax push, or steadicam walk. Always specify slow/very slow speed.

Return ONLY valid JSON — no markdown fences, no explanation.

{
  "title": "video title from script content",
  "estimated_duration_seconds": <from user message>,
  "scene_count": <total scenes you chose>,
  "tone_summary": "2-3 sentences on visual tone, pacing strategy, and emotional arc",
  "research_notes": "Your detailed answers to all 5 research questions above",
  "visual_style_guide": "ERA: ... | REGION: ... | CHARACTERS: ... | SETTINGS: ... | NEVER: ...",
  "scenes": [
    {
      "scene_number": 1,
      "duration_sec": 12,
      "script_excerpt": "...",
      "description": "...",
      "image_prompt": "...",
      "motion_prompt": "..."
    }
  ],
  "cost_estimate": {
    "image_generation_usd": <scene_count * 0.06>,
    "video_generation_usd": <scene_count * 0.05>,
    "claude_api_usd": 0.02,
    "total_usd": <sum>,
    "per_scene_breakdown": "Each scene: $0.06 image + $0.05 video = $0.11"
  }
}`

/**
 * Parse Claude's response into a valid JS object.
 *
 * Handles three failure modes:
 *  1. Markdown fences around JSON (```json … ```)
 *  2. Trailing non-JSON text after the closing brace
 *  3. Truncated JSON caused by hitting max_tokens — repairs by closing
 *     any open arrays/objects, then splicing in a default cost_estimate
 *     if that key was never completed.
 */
/**
 * Split the narration script into exactly `sceneCount` segments server-side.
 * Claude only generates image/motion prompts — it never decides how to divide the script.
 */
function segmentScript(script, sceneCount) {
  // Remove non-spoken dividers (---, ***, etc.)
  const cleaned = script.replace(/^[-*]{2,}\s*$/gm, '').replace(/\n{3,}/g, '\n\n').trim()

  // Split on sentence-ending punctuation followed by whitespace
  const sentences = cleaned.match(/[^.!?]+[.!?]+(\s|$)/g)?.map(s => s.trim()).filter(Boolean) || [cleaned]

  const totalWords = sentences.reduce((n, s) => n + s.split(/\s+/).filter(Boolean).length, 0)
  const targetWords = totalWords / sceneCount

  const segments = []
  let buf = []
  let bufWords = 0

  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i]
    const w = s.split(/\s+/).filter(Boolean).length
    buf.push(s)
    bufWords += w

    const scenesLeft = sceneCount - segments.length
    const sentencesLeft = sentences.length - i - 1

    // Commit segment when we've hit the word target and there are enough
    // sentences remaining to fill the rest of the scenes
    if (bufWords >= targetWords && sentencesLeft >= scenesLeft - 1 && segments.length < sceneCount - 1) {
      segments.push(buf.join(' '))
      buf = []
      bufWords = 0
    }
  }

  // Remaining sentences form the last segment
  if (buf.length) segments.push(buf.join(' '))

  // Safety: trim or pad to exact count
  while (segments.length > sceneCount) {
    const last = segments.pop()
    segments[segments.length - 1] += ' ' + last
  }
  while (segments.length < sceneCount) segments.push(segments[segments.length - 1] || '...')

  return segments
}

function parseResponse(text, serverDurSec) {
  // Strip markdown fences
  text = text.replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '').trim()

  // Parse — try clean JSON first, then attempt repair for truncated responses
  let obj
  try {
    obj = JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    if (start > 0) text = text.slice(start)
    const repaired = closeOpenStructures(text)
    try {
      obj = JSON.parse(repaired)
    } catch (e) {
      throw new Error(`JSON repair failed: ${e.message}`)
    }
  }

  // ── All post-processing runs on every successful parse ────────────────────

  // Server's word-count duration is authoritative. Claude frequently inflates
  // short dramatic scripts (e.g. 65 words → 91s instead of 30s). Pin it first
  // so every downstream calculation uses the correct total.
  if (serverDurSec) obj.estimated_duration_seconds = serverDurSec

  // Keep only complete scenes
  if (Array.isArray(obj.scenes)) {
    obj.scenes = obj.scenes
      .filter((s) => s && s.scene_number && s.image_prompt && s.motion_prompt)
    obj.scene_count = obj.scenes.length
  }

  // Override director's duration_sec with word-count-proportional values so
  // video cuts align with narration speaking time, not the AI's guesses.
  if (Array.isArray(obj.scenes) && obj.scenes.length > 0 && obj.estimated_duration_seconds > 0) {
    const totalDurSec = obj.estimated_duration_seconds
    const wordCounts = obj.scenes.map(s =>
      Math.max(1, (s.script_excerpt || '').split(/\s+/).filter(Boolean).length)
    )
    const totalWords = wordCounts.reduce((a, b) => a + b, 0)
    let assigned = 0
    obj.scenes = obj.scenes.map((s, i) => {
      let dur
      if (i === obj.scenes.length - 1) {
        dur = Math.max(3, Math.round(totalDurSec) - assigned)
      } else {
        dur = Math.max(3, Math.round((wordCounts[i] / totalWords) * totalDurSec))
        assigned += dur
      }
      return { ...s, duration_sec: dur }
    })
  } else if (Array.isArray(obj.scenes)) {
    obj.scenes = obj.scenes.map(s => ({ ...s, duration_sec: 5 }))
  }

  // Recalculate cost from actual scene count
  if (obj.scene_count) {
    const n = obj.scene_count
    const img = +(n * 0.06).toFixed(2)
    const vid = +(n * 0.05).toFixed(2)
    obj.cost_estimate = {
      image_generation_usd: img,
      video_generation_usd: vid,
      claude_api_usd: 0.02,
      total_usd: +(img + vid + 0.02).toFixed(2),
      per_scene_breakdown: 'Each scene: $0.06 image + $0.05 video = $0.11',
    }
  }

  return obj
}

/**
 * Walk through a (possibly truncated) JSON string tracking open
 * braces/brackets, then append the missing closing tokens.
 * If we're mid-string, close the string first; if the last character
 * before the stack is a comma, strip it (trailing commas are invalid JSON).
 */
function closeOpenStructures(str) {
  const stack = []   // expected closing tokens
  let inStr = false
  let esc   = false
  let firstCompleteAt = -1  // index after the char that empties the stack

  for (let i = 0; i < str.length; i++) {
    const ch = str[i]

    if (esc) { esc = false; continue }

    if (inStr) {
      if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }

    if (ch === '"') { inStr = true; continue }
    if (ch === '{') { stack.push('}'); continue }
    if (ch === '[') { stack.push(']'); continue }
    if ((ch === '}' || ch === ']') && stack.length) {
      stack.pop()
      if (stack.length === 0 && firstCompleteAt < 0) firstCompleteAt = i + 1
    }
  }

  // JSON was complete but Claude appended trailing text — strip it
  if (stack.length === 0 && firstCompleteAt > 0 && firstCompleteAt < str.length) {
    return str.slice(0, firstCompleteAt)
  }

  if (stack.length === 0) return str  // already balanced, nothing to fix

  let out = str
  // Close an open string literal first
  if (inStr) out += '"'
  // Strip a trailing comma that would appear before a closing bracket
  out = out.trimEnd().replace(/,\s*$/, '')
  // Append closing tokens in reverse order
  out += stack.reverse().join('')
  return out
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { script } = req.body || {}
  if (!script?.trim()) return res.status(400).json({ error: 'Script text is required' })

  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.VITE_ANTHROPIC_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured' })

  // Pre-compute metadata only — the director AI decides scene count and durations.
  const MAX_SCENES = 120
  const narrationWords = script.replace(/^[-*]{2,}\s*$/gm, '').trim().split(/\s+/).filter(Boolean).length
  const estimatedDurSec = Math.round(narrationWords / 130 * 60)

  // Switch to SSE — keeps the iOS Safari connection alive with pings while
  // Claude generates (which can take 60-150 seconds for long scripts).
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`)

  send({ type: 'progress', message: `Director is reading the script and planning ${Math.round(estimatedDurSec / 60)}-minute edit…` })

  // Ping every 10 s so iOS Safari doesn't drop the idle connection.
  const pingInterval = setInterval(() => send({ type: 'ping' }), 10000)

  try {
    const client = new Anthropic({ apiKey })

    const userMessage = [
      `Script metadata:`,
      `  spoken_word_count = ${narrationWords}`,
      `  estimated_duration_seconds = ${estimatedDurSec}`,
      `  max_scenes = ${MAX_SCENES}`,
      ``,
      `Full narration script:`,
      ``,
      script.trim(),
    ].join('\n')

    const stream = client.messages.stream({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 20000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    })
    const raw = await stream.finalText()
    const brief = parseResponse(raw, estimatedDurSec)

    if (!brief.scenes?.length) {
      send({ type: 'error', message: 'No scenes were parsed from the script. Try a shorter script or check the format.' })
    } else {
      send({ type: 'complete', data: brief })
    }
  } catch (err) {
    console.error('analyze error:', err)
    send({ type: 'error', message: err.message || 'Analysis failed' })
  } finally {
    clearInterval(pingInterval)
    res.end()
  }
}
