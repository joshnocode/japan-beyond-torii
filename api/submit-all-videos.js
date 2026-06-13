import { fal } from '@fal-ai/client'

export const maxDuration = 60

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { scenes } = req.body || {}
  if (!Array.isArray(scenes) || !scenes.length) return res.status(400).json({ error: 'scenes array is required' })

  const apiKey = process.env.FAL_API_KEY || process.env.VITE_FAL_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'FAL_API_KEY is not configured' })

  fal.config({ credentials: apiKey })

  const results = await Promise.allSettled(
    scenes.map(async (scene) => {
      const { request_id } = await fal.queue.submit(
        'bytedance/seedance-2.0/fast/image-to-video',
        {
          input: {
            image_url: scene.image_url,
            prompt: scene.motion_prompt || 'slow cinematic camera movement',
            duration: 5,
            resolution: '720p',
            aspect_ratio: '9:16',
            generate_audio: false,
          },
        }
      )
      return { scene_id: scene.id, request_id }
    })
  )

  const submitted = results
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value)

  const failed = results
    .filter(r => r.status === 'rejected')
    .length

  return res.status(200).json({ submitted, failed })
}
