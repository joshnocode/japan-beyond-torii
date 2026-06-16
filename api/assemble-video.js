import { createClient } from '@supabase/supabase-js'

export const maxDuration = 300

const BATCH_SIZE = 5

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

  const [{ data: project, error: projErr }, { data: scenes }] = await Promise.all([
    supabase.from('projects').select('*').eq('id', project_id).single(),
    supabase.from('scenes').select('scene_index,video_url').eq('project_id', project_id).order('scene_index'),
  ])

  if (projErr || !project) return res.status(404).json({ error: 'Project not found' })

  const missing = (scenes || []).filter(s => !s.video_url)
  if (missing.length) return res.status(400).json({ error: `${missing.length} scenes are missing video` })

  // Build batch plan
  const batches = []
  for (let b = 0; b * BATCH_SIZE < scenes.length; b++) {
    batches.push({
      batch_index: b,
      scene_ids: scenes.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE).map(s => ({
        video_url: s.video_url,
        scene_index: s.scene_index,
      })),
    })
  }

  // Mark assembling and clean up stale files from any previous attempt
  await supabase.from('projects')
    .update({ status: 'assembling', assembly_error: null })
    .eq('id', project_id)

  // Remove old batch + error files (best-effort)
  const staleFiles = batches.flatMap(b => [
    `${project.user_id}/${project_id}/batch_${b.batch_index}.mp4`,
    `${project.user_id}/${project_id}/batch_${b.batch_index}.error`,
  ])
  await supabase.storage.from('project-assets').remove(staleFiles).catch(() => {})

  res.status(202).json({ status: 'assembling', batch_count: batches.length })

  // ─── Everything below runs after the client receives the 202 ───

  const baseUrl = `https://${req.headers.host}`
  const authHeader = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }

  try {
    // Fire all batch jobs + final assembly simultaneously.
    // The final Lambda polls for batch completion itself — giving it a full 300s budget.
    console.log(`[orchestrator] firing ${batches.length} batch jobs + final assembly`)
    await Promise.all([
      ...batches.map(b =>
        fetch(`${baseUrl}/api/assemble-batch`, {
          method: 'POST',
          headers: authHeader,
          body: JSON.stringify({ project_id, batch_index: b.batch_index, scene_ids: b.scene_ids }),
        }).then(r => {
          if (!r.ok) throw new Error(`Batch ${b.batch_index} kickoff failed: HTTP ${r.status}`)
        })
      ),
      fetch(`${baseUrl}/api/assemble-final`, {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({ project_id, batch_count: batches.length }),
      }).then(r => {
        if (!r.ok) throw new Error(`Final assembly kickoff failed: HTTP ${r.status}`)
      }),
    ])
    console.log('[orchestrator] all jobs fired — exiting')
  } catch (err) {
    console.error('[orchestrator] FAILED:', err.message)
    await supabase.from('projects')
      .update({ status: 'videos_ready', assembly_error: err.message })
      .eq('id', project_id)
      .catch(() => {})
  }
}
