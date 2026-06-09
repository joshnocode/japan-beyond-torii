import { fal } from '@fal-ai/client'

const MODEL = 'bytedance/seedance-2.0/fast/image-to-video'

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const { request_id } = req.query
  if (!request_id) return res.status(400).json({ error: 'request_id is required' })

  const apiKey = process.env.FAL_API_KEY || process.env.VITE_FAL_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'FAL_API_KEY is not configured' })

  fal.config({ credentials: apiKey })

  try {
    const status = await fal.queue.status(MODEL, {
      requestId: request_id,
      logs: false,
    })

    if (status.status === 'COMPLETED') {
      const result = await fal.queue.result(MODEL, { requestId: request_id })
      const videoUrl = result?.data?.video?.url
      if (!videoUrl) throw new Error('No video URL in completed result')
      return res.status(200).json({ status: 'done', video_url: videoUrl })
    }

    if (status.status === 'FAILED') {
      return res.status(200).json({ status: 'error', error: 'Fal.ai job failed' })
    }

    // IN_QUEUE or IN_PROGRESS
    return res.status(200).json({ status: status.status.toLowerCase() })
  } catch (err) {
    console.error('poll-video error:', err)
    return res.status(500).json({ error: err.message || 'Poll failed' })
  }
}
