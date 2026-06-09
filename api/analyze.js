import Anthropic from '@anthropic-ai/sdk'

const SYSTEM_PROMPT = `You are a cinematic director for a Japanese historical documentary channel called Japan Beyond The Torii.

Your job is to analyze a narration script and break it into scenes for video production.

Rules:
- Split the script into scenes of 3-6 sentences each
- For each scene, generate a detailed FLUX image prompt: architectural illustration style, cinematic composition, feudal Japanese setting, dramatic lighting, and specific visual elements mentioned in that scene
- For each scene, generate a Seedance motion prompt: slow cinematic camera movement (dolly, pan, parallax, push-in, pull-back, etc.) that suits the emotional tone
- Estimate duration assuming ~130 words per minute narration pace
- Cost rates: FLUX 1.1 Pro Ultra = $0.06 per image, Seedance 2.0 Fast 5s clip = $0.05 per clip, Claude analysis = $0.02 flat

Return ONLY valid JSON — no markdown fences, no explanation, nothing else before or after the JSON object.

JSON structure:
{
  "title": "suggested video title derived from script content",
  "estimated_duration_seconds": <integer>,
  "scene_count": <integer>,
  "tone_summary": "2-3 sentences on the overall visual tone, pacing, and emotional register",
  "scenes": [
    {
      "scene_number": 1,
      "script_excerpt": "the exact sentences from the script assigned to this scene",
      "description": "1-2 sentence visual description of what the viewer sees",
      "image_prompt": "detailed FLUX prompt — specify: architectural illustration style, ink and watercolor texture, feudal Japanese architecture/landscape, cinematic composition rule (rule of thirds / leading lines / etc.), lighting quality (golden hour / moonlight / dramatic overcast), specific props and environmental details from the scene content",
      "motion_prompt": "Seedance motion description — specify camera move type, speed (slow/very slow), direction, and what element the camera is drawn toward"
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

  try {
    const client = new Anthropic({ apiKey })

    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,          // doubled — prevents truncation for scripts up to ~30 scenes
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Analyze this script:\n\n${script}` }],
    })

    const raw = message.content[0].text
    const brief = parseResponse(raw)

    if (!brief.scenes?.length) {
      return res.status(422).json({ error: 'No scenes were parsed from the script. Try a shorter script or check the format.' })
    }

    return res.status(200).json(brief)
  } catch (err) {
    console.error('analyze error:', err)
    return res.status(500).json({ error: err.message || 'Analysis failed' })
  }
}
