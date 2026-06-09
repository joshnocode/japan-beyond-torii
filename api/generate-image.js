import { fal } from '@fal-ai/client'

export const maxDuration = 60

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { image_prompt } = req.body || {}
  if (!image_prompt?.trim()) return res.status(400).json({ error: 'image_prompt is required' })

  const apiKey = process.env.FAL_API_KEY || process.env.VITE_FAL_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'FAL_API_KEY is not configured' })

  fal.config({ credentials: apiKey })

  try {
    const result = await fal.subscribe('fal-ai/flux-pro/v1.1-ultra', {
      input: {
        prompt: image_prompt,
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
