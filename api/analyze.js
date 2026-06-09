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

function extractJson(text) {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) return fenceMatch[1].trim()
  const objMatch = text.match(/\{[\s\S]*\}/)
  if (objMatch) return objMatch[0]
  return text.trim()
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
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Analyze this script:\n\n${script}` }],
    })

    const raw = message.content[0].text
    const jsonStr = extractJson(raw)
    const brief = JSON.parse(jsonStr)

    return res.status(200).json(brief)
  } catch (err) {
    console.error('analyze error:', err)
    return res.status(500).json({ error: err.message || 'Analysis failed' })
  }
}
