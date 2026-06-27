import { fal } from '@fal-ai/client'

export const maxDuration = 60

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { image_prompt, style_guide, reference_image_url } = req.body || {}
  if (!image_prompt?.trim()) return res.status(400).json({ error: 'image_prompt is required' })

  const PHOTO_PREFIX = 'Photorealistic cinematic 35mm documentary footage set in pre-modern historical Japan, rich saturated colors, high contrast cinematic lighting, vivid and vibrant, crisp historical textures, zero contemporary or modern elements, zero illustration or anime — '

  const fullPrompt = style_guide?.trim()
    ? `${PHOTO_PREFIX}${style_guide.trim()}\n\n${image_prompt.trim()}`
    : `${PHOTO_PREFIX}${image_prompt.trim()}`

  const apiKey = process.env.FAL_API_KEY || process.env.VITE_FAL_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'FAL_API_KEY is not configured' })

  fal.config({ credentials: apiKey })

  try {
    const result = await fal.subscribe('fal-ai/flux-pro/v1.1-ultra', {
      input: {
        prompt: fullPrompt,
        // Soft visual reference from scene 1 — anchors color temperature, lighting mood,
        // and atmospheric quality across the video without constraining composition.
        ...(reference_image_url ? {
          image_prompt: reference_image_url,
          image_prompt_strength: 0.12,
        } : {}),
        negative_prompt: 'ukiyo-e, woodblock print, woodblock, sumi-e, ink wash, Japanese illustration, ukiyo, woodcut, manga, anime, illustration, cartoon, painting, watercolor, ink, sketch, cel-shaded, drawing, comic book, digital art, stylized, flat, 2D, art print, decorative art, museum print, text, writing, maps, documents, scrolls, letters, captions, signs with text, modern clothing, western clothing, jeans, t-shirt, sneakers, suit, tie, contemporary hairstyle, glasses, wristwatch, taxi, cab, automobile, sedan, van, bus, cars, trucks, motorcycles, bicycles, trains, vehicles, modern road, paved road, parking lot, modern building, contemporary building, electric lights, power lines, neon signs, concrete, asphalt, glass and steel buildings, metal scaffolding, power tools, plastic, synthetic fabric, fluorescent lighting, LED lighting, telephone pole, telephone wire, vending machine',
        aspect_ratio: '9:16',
        output_format: 'jpeg',
        safety_tolerance: '2',
        num_images: 1,
      },
      pollInterval: 2000,
    })

    const imageUrl = result?.data?.images?.[0]?.url
    if (!imageUrl) throw new Error('No image URL returned from Fal.ai')

    return res.status(200).json({ image_url: imageUrl })
  } catch (err) {
    console.error('generate-image error:', err)
    return res.status(500).json({ error: err.message || 'Image generation failed' })
  }
}
