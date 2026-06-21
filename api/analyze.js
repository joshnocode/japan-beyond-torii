import Anthropic from '@anthropic-ai/sdk'

export const maxDuration = 300

const SYSTEM_PROMPT = `You are a cinematic director for a Japanese historical documentary channel called Japan Beyond The Torii.

The script has already been divided into scenes for you. Your job is to generate visual prompts for each scene.

For each scene you receive, output:
- scene_number: the scene index provided
- script_excerpt: copy the excerpt EXACTLY as given — do not modify, expand, or rewrite it
- description: 1-2 sentence visual description of what the viewer sees
- image_prompt: detailed FLUX photorealistic prompt — style MUST be: photorealistic, 8K cinematic photography, National Geographic documentary style, tangible real-world textures (aged wood grain, mossy stone, worn fabric). Specify the primary subject: either an architectural/landscape scene OR a human figure that fits the narration (a lone Hida carpenter shaping timber with hand tools, a Tokugawa official in formal kimono inspecting a courtyard, a merchant carrying goods through a snow-dusted street, a samurai standing before castle gates — always period-accurate Edo-era Japanese dress, seen from behind or at distance for anonymity). Add lighting quality (golden hour side-light, overcast diffused, blue-hour glow, lantern-lit interior). Apply a composition rule (rule of thirds, leading lines, foreground frame). Include specific environmental details from the scene narration. Aim for roughly half the scenes to feature a human figure and half to be pure environment/architecture — vary the two. CRITICAL — NEVER include: anime, illustration, cartoon, painting, watercolor, ink, sketch, cel-shaded, drawing, comic book, digital art, stylized, flat, 2D. NEVER depict text, writing, maps, scrolls, or documents.
- motion_prompt: Seedance 3D camera movement — MUST describe a physical camera action. Choose one: slow dolly forward through [specific architectural element], aerial drone descent over [landmark or landscape], low-angle tracking shot following [subject or path], sweeping crane reveal of [vista], parallax push past [foreground object] revealing [background], steadicam walk through [interior or street]. Specify speed (slow / very slow) and the exact subject. Must feel like live-action cinematography.

Return ONLY valid JSON — no markdown fences, no explanation.

JSON structure:
{
  "title": "suggested video title derived from script content",
  "estimated_duration_seconds": <integer — provided in the user message>,
  "scene_count": <integer — number of scenes provided>,
  "tone_summary": "2-3 sentences on the overall visual tone, pacing, and emotional register",
  "scenes": [
    {
      "scene_number": 1,
      "script_excerpt": "<exact copy of the excerpt provided>",
      "description": "...",
      "image_prompt": "...",
      "motion_prompt": "..."
    }
  ],
  "cost_estimate": {
    "image_generation_usd": <scene_count * 0.06, rounded to 2 decimals>,
    "video_generation_usd": <scene_count * 0.05, rounded to 2 decimals>,
    "claude_api_usd": 0.02,
    "total_usd": <sum, rounded to 2 decimals>,
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

function parseResponse(text) {
  // Strip markdown fences
  text = text.replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '').trim()

  // Fast path — already valid
  try { return JSON.parse(text) } catch {}

  // Strip anything before the first `{`
  const start = text.indexOf('{')
  if (start > 0) text = text.slice(start)

  // Try closing any open structures left by truncation
  const repaired = closeOpenStructures(text)

  try {
    const obj = JSON.parse(repaired)
    // If cost_estimate was truncated/missing, synthesise a default from scene_count
    if (!obj.cost_estimate && obj.scene_count) {
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
    // Keep only complete scenes (scene_number, image_prompt, motion_prompt all present)
    if (Array.isArray(obj.scenes)) {
      obj.scenes = obj.scenes.filter(
        (s) => s && s.scene_number && s.image_prompt && s.motion_prompt
      )
      obj.scene_count = obj.scenes.length
    }
    // Always recalculate cost from actual scene count so the UI numbers are consistent
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
  } catch (e) {
    throw new Error(`JSON repair failed: ${e.message}`)
  }
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
    if ((ch === '}' || ch === ']') && stack.length) stack.pop()
  }

  if (stack.length === 0) return str  // already balanced

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

  // Pre-compute scene count and pre-segment before switching to SSE mode.
  const narrationWords = script.replace(/^[-*]{2,}\s*$/gm, '').trim().split(/\s+/).filter(Boolean).length
  const estimatedDurSec = Math.round(narrationWords / 130 * 60)
  const requiredSceneCount = Math.ceil(estimatedDurSec / 5)
  const segments = segmentScript(script, requiredSceneCount)

  // Switch to SSE — keeps the iOS Safari connection alive with pings while
  // Claude generates (which can take 60-150 seconds for long scripts).
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`)

  send({ type: 'progress', message: `Generating prompts for ${requiredSceneCount} scenes…` })

  // Ping every 10 s so iOS Safari doesn't drop the idle connection.
  const pingInterval = setInterval(() => send({ type: 'ping' }), 10000)

  try {
    const client = new Anthropic({ apiKey })

    const sceneList = segments.map((text, i) => `Scene ${i + 1}: "${text}"`).join('\n')

    const userMessage = [
      `Script metadata:`,
      `  spoken_word_count = ${narrationWords}`,
      `  estimated_duration_seconds = ${estimatedDurSec}`,
      `  scene_count = ${requiredSceneCount}`,
      ``,
      `The script has been pre-divided into exactly ${requiredSceneCount} scenes below.`,
      `Generate description, image_prompt, and motion_prompt for each scene.`,
      `Copy each scene's text as the script_excerpt — do NOT change it.`,
      ``,
      sceneList,
    ].join('\n')

    const stream = client.messages.stream({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 20000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    })
    const raw = await stream.finalText()
    const brief = parseResponse(raw)

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
