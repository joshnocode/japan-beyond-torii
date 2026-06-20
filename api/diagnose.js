import { createClient } from '@supabase/supabase-js'

export const maxDuration = 30

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

  // Check each scene URL with a HEAD request (parallel, 10s timeout each)
  const urlChecks = await Promise.all((scenes || []).map(async (s) => {
    if (!s.video_url) return { scene: s.scene_index + 1, status: 'MISSING', url: null }
    try {
      const controller = new AbortController()
      const tid = setTimeout(() => controller.abort(), 10000)
      const r = await fetch(s.video_url, { method: 'HEAD', signal: controller.signal })
      clearTimeout(tid)
      return { scene: s.scene_index + 1, status: r.ok ? 'OK' : `HTTP_${r.status}`, url: s.video_url.slice(0, 80) }
    } catch (e) {
      return { scene: s.scene_index + 1, status: e.name === 'AbortError' ? 'TIMEOUT' : `ERROR: ${e.message}`, url: s.video_url.slice(0, 80) }
    }
  }))

  // Check audio URL
  let audioStatus = 'NO_AUDIO'
  if (project.audio_url) {
    try {
      const controller = new AbortController()
      const tid = setTimeout(() => controller.abort(), 10000)
      const r = await fetch(project.audio_url, { method: 'HEAD', signal: controller.signal })
      clearTimeout(tid)
      audioStatus = r.ok ? 'OK' : `HTTP_${r.status}`
    } catch (e) {
      audioStatus = e.name === 'AbortError' ? 'TIMEOUT' : `ERROR: ${e.message}`
    }
  }

  // Check batch files in storage (leftovers from previous attempts)
  const { data: storageListing } = await supabase.storage
    .from('project-assets')
    .list(`${project.user_id}/${project_id}`, { limit: 100 })

  const deadUrls = urlChecks.filter(u => u.status !== 'OK')
  const okUrls   = urlChecks.filter(u => u.status === 'OK')

  return res.status(200).json({
    project_id,
    project_status: project.status,
    assembly_error: project.assembly_error,
    scene_count: scenes?.length ?? 0,
    urls_ok: okUrls.length,
    urls_dead: deadUrls.length,
    audio_status: audioStatus,
    storage_files: storageListing?.map(f => f.name) ?? [],
    dead_scenes: deadUrls,
    all_scenes: urlChecks,
  })
}
