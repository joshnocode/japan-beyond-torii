import { fal } from '@fal-ai/client'

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { image_url, motion_prompt } = req.body || {}
  if (!image_url) return res.status(400).json({ error: 'image_url is required' })

  const apiKey = process.env.FAL_API_KEY || process.env.VITE_FAL_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'FAL_API_KEY is not configured' })

  fal.config({ credentials: apiKey })

  try {
    const { request_id } = await fal.queue.submit(
      'bytedance/seedance-2.0/fast/image-to-video',
      {
        input: {
          image_url,
          prompt: motion_prompt || 'slow cinematic camera movement',
          duration: 5,
          resolution: '720p',
          aspect_ratio: '9:16',
          generate_audio: false,
        },
      }
    )

    return res.status(200).json({ request_id })
  } catch (err) {
    console.error('submit-video error:', err)
    return res.status(500).json({ error: err.message || 'Failed to submit video job' })
  }
}
