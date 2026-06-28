import { createClient } from '@supabase/supabase-js'

export const maxDuration = 60

const VOICE_ID = 'rGhYYdTj7DVaEcUFIHXm' // Alfred

function chunkText(text, maxChars = 4500) {
  const sentences = text.match(/[^.!?]+[.!?]+[\s]*/g) || [text]
  const chunks = []
  let current = ''
  for (const s of sentences) {
    if (current.length + s.length > maxChars && current) {
      chunks.push(current.trim())
      current = s
    } else {
      current += s
    }
  }
  if (current.trim()) chunks.push(current.trim())
  return chunks.length ? chunks : [text]
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'Authorization required' })

  const { project_id } = req.body || {}
  if (!project_id) return res.status(400).json({ error: 'project_id is required' })

  const apiKey = process.env.ELEVENLABS_API_KEY || process.env.VITE_ELEVENLABS_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'ELEVENLABS_API_KEY is not configured' })

  const supabase = createClient(
    process.env.VITE_SUPABASE_URL,
    process.env.VITE_SUPABASE_ANON_KEY,
    { global: { headers: { Authorization: `Bearer ${token}` } } }
  )

  const { data: project, error: projErr } = await supabase
    .from('projects').select('user_id, script').eq('id', project_id).single()
  if (projErr || !project) return res.status(404).json({ error: 'Project not found' })
  if (!project.script?.trim()) return res.status(400).json({ error: 'Project has no script text' })

  try {
    const chunks = chunkText(project.script)
    if (chunks.length > 20) return res.status(400).json({ error: `Script too long for audio generation (${chunks.length} chunks — max 20, ~90,000 characters)` })

    const buffers = []
    // Accumulated character-level alignment across all chunks (offset-adjusted)
    const allChars = []
    const allStarts = []
    const allEnds = []
    let timeOffset = 0

    for (const chunk of chunks) {
      // /with-timestamps returns JSON { audio_base64, alignment } instead of raw audio bytes
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/with-timestamps`, {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: chunk,
          model_id: 'eleven_multilingual_v2',
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      })

      if (!r.ok) {
        let errMsg = `ElevenLabs error ${r.status}`
        try {
          const body = await r.json()
          errMsg = body?.detail?.message || body?.detail || errMsg
        } catch {}
        throw new Error(errMsg)
      }

      const data = await r.json()
      if (!data.audio_base64) throw new Error('ElevenLabs response missing audio_base64')
      buffers.push(Buffer.from(data.audio_base64, 'base64'))

      // Merge this chunk's alignment into the master list, shifted by timeOffset
      const { characters, character_start_times_seconds, character_end_times_seconds } = data.alignment || {}
      if (characters?.length && character_start_times_seconds?.length) {
        for (let i = 0; i < characters.length; i++) {
          allChars.push(characters[i])
          allStarts.push((character_start_times_seconds[i] || 0) + timeOffset)
          allEnds.push((character_end_times_seconds[i] || 0) + timeOffset)
        }
        // Advance offset by this chunk's actual spoken duration
        timeOffset += character_end_times_seconds.at(-1) || 0
      } else {
        // Missing alignment for this chunk — subsequent chunks would get wrong timestamps.
        // Clear accumulated data so we don't upload a broken partial alignment.
        allChars.length = 0
        allStarts.length = 0
        allEnds.length = 0
      }
    }

    const combined = Buffer.concat(buffers)

    // Upload audio
    const audioPath = `${project.user_id}/${project_id}/audio.mp3`
    const { error: uploadErr } = await supabase.storage
      .from('project-assets')
      .upload(audioPath, combined, { contentType: 'audio/mpeg', upsert: true })
    if (uploadErr) throw new Error(`Upload failed: ${uploadErr.message}`)

    const { data: urlData } = supabase.storage.from('project-assets').getPublicUrl(audioPath)

    // Upload alignment JSON — used at assembly time for subtitle generation
    let alignmentCaptured = false
    if (allChars.length > 0) {
      const alignment = {
        characters: allChars,
        character_start_times_seconds: allStarts,
        character_end_times_seconds: allEnds,
      }
      const alignBuf = Buffer.from(JSON.stringify(alignment))
      const alignPath = `${project.user_id}/${project_id}/alignment.json`
      const { error: alignErr } = await supabase.storage
        .from('project-assets')
        .upload(alignPath, alignBuf, { contentType: 'application/json', upsert: true })
      alignmentCaptured = !alignErr
    }

    await supabase.from('projects').update({ audio_url: urlData.publicUrl }).eq('id', project_id)

    return res.status(200).json({ audio_url: urlData.publicUrl, alignment_captured: alignmentCaptured })
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Audio generation failed' })
  }
}
