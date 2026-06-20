import { createClient } from '@supabase/supabase-js'

export const maxDuration = 30

// Fetch first 16 bytes via Range request — enough to verify MP4 magic bytes
async function probeUrl(url) {
  const controller = new AbortController()
  const tid = setTimeout(() => controller.abort(), 12000)
  try {
    const r = await fetch(url, {
      headers: { Range: 'bytes=0-15' },
      signal: controller.signal,
    })
    clearTimeout(tid)

    const contentType = r.headers.get('content-type') || ''
    const contentLength = r.headers.get('content-range') || r.headers.get('content-length') || ''

    if (!r.ok && r.status !== 206) {
      return { status: `HTTP_${r.status}`, contentType, size: null, mp4: false }
    }

    const buf = Buffer.from(await r.arrayBuffer())
    // MP4 files have 'ftyp' at bytes 4-7, or start with 0x00 0x00 0x00 ...
    const isMp4 = buf.length >= 8 && buf.slice(4, 8).toString('ascii') === 'ftyp'
    const preview = buf.toString('hex').slice(0, 16)

    // Parse total size from Content-Range: bytes 0-15/TOTAL
    let sizeMB = null
    const rangeMatch = contentLength.match(/\/(\d+)/)
    if (rangeMatch) sizeMB = (parseInt(rangeMatch[1]) / 1024 / 1024).toFixed(1)

    return { status: r.status === 206 ? 'OK_206' : `OK_${r.status}`, contentType, sizeMB, mp4: isMp4, preview }
  } catch (e) {
    clearTimeout(tid)
    return { status: e.name === 'AbortError' ? 'TIMEOUT' : `ERROR: ${e.message}`, mp4: false }
  }
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

  const supabase = createClient(
    process.env.VITE_SUPABASE_URL,
    process.env.VITE_SUPABASE_ANON_KEY,
    { global: { headers: { Authorization: `Bearer ${token}` } } }
  )

  const { data: project, error: projErr } = await supabase
    .from('projects').select('*').eq('id', project_id).single()
  if (projErr || !project) return res.status(404).json({ error: 'Project not found' })

  const { data: scenes } = await supabase
    .from('scenes')
    .select('scene_index, video_url')
    .eq('project_id', project_id)
    .order('scene_index')

  // Probe every scene URL — checks actual bytes, not just headers
  const urlChecks = await Promise.all((scenes || []).map(async (s) => {
    if (!s.video_url) return { scene: s.scene_index + 1, status: 'MISSING' }
    const probe = await probeUrl(s.video_url)
    return { scene: s.scene_index + 1, ...probe, url: s.video_url.slice(0, 80) }
  }))

  // Probe audio
  let audioProbe = { status: 'NO_AUDIO' }
  if (project.audio_url) audioProbe = await probeUrl(project.audio_url)

  // Storage files
  const { data: storageListing } = await supabase.storage
    .from('project-assets')
    .list(`${project.user_id}/${project_id}`, { limit: 100 })

  const badScenes  = urlChecks.filter(u => !u.mp4)
  const goodScenes = urlChecks.filter(u => u.mp4)

  // Summarise file sizes
  const sizes = urlChecks.filter(u => u.sizeMB).map(u => parseFloat(u.sizeMB))
  const totalMB = sizes.reduce((a, b) => a + b, 0).toFixed(1)
  const avgMB   = sizes.length ? (totalMB / sizes.length).toFixed(1) : null

  return res.status(200).json({
    project_status: project.status,
    assembly_error: project.assembly_error,
    scene_count: scenes?.length ?? 0,
    real_mp4_count: goodScenes.length,
    bad_count: badScenes.length,
    audio: audioProbe,
    total_video_MB: totalMB,
    avg_clip_MB: avgMB,
    storage_files: storageListing?.map(f => f.name) ?? [],
    bad_scenes: badScenes,
    all_scenes: urlChecks,
  })
}
