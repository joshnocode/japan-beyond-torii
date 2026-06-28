import { createClient } from '@supabase/supabase-js'

export const maxDuration = 30

// Projects stuck in these states for longer than STALE_HOURS are orphaned —
// the Vercel function that was managing them has already timed out and died.
const STALE_HOURS = 6

export default async function handler(req, res) {
  // Vercel automatically sends Authorization: Bearer <CRON_SECRET> for cron invocations.
  // Any other caller gets rejected.
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const supabase = createClient(
    process.env.VITE_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY // service role bypasses RLS to see all projects
  )

  const staleThreshold = new Date(Date.now() - STALE_HOURS * 60 * 60 * 1000).toISOString()
  const ranAt = new Date().toISOString()

  // ── Find stuck projects ───────────────────────────────────────────────────
  const { data: stale, error: fetchErr } = await supabase
    .from('projects')
    .select('id, title, status, updated_at')
    .in('status', ['assembling', 'processing', 'generating_videos'])
    .lt('updated_at', staleThreshold)

  if (fetchErr) return res.status(500).json({ error: fetchErr.message, ran_at: ranAt })

  const cleaned = []
  for (const p of stale || []) {
    // assembling — assembly Vercel fn already died; revert so user can re-assemble
    // processing / generating_videos — resume logic on ProjectPage handles these;
    // just mark with a note so the user knows why it was reset if they check
    const revertTo = p.status === 'assembling' ? 'videos_ready' : p.status
    const { error: updateErr } = await supabase
      .from('projects')
      .update({
        status: revertTo,
        assembly_error: `Auto-cleaned by daily cron: project was stuck in "${p.status}" for over ${STALE_HOURS}h. Open the project to resume.`,
      })
      .eq('id', p.id)

    cleaned.push({
      id: p.id,
      title: p.title,
      was: p.status,
      reverted_to: revertTo,
      stuck_since: p.updated_at,
      ok: !updateErr,
      ...(updateErr ? { err: updateErr.message } : {}),
    })
  }

  // ── Daily spend estimate (sum of cost_cents on projects created today) ────
  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)
  const { data: todayProjects } = await supabase
    .from('projects')
    .select('cost_cents, title, created_at')
    .gte('created_at', todayStart.toISOString())

  const todaySpendCents = (todayProjects || []).reduce((s, p) => s + (p.cost_cents || 0), 0)

  return res.status(200).json({
    ran_at: ranAt,
    stale_hours_threshold: STALE_HOURS,
    projects_cleaned: cleaned.length,
    cleaned,
    today_estimated_spend_usd: (todaySpendCents / 100).toFixed(2),
    today_projects: (todayProjects || []).map(p => ({
      title: p.title,
      cost_usd: ((p.cost_cents || 0) / 100).toFixed(2),
      created_at: p.created_at,
    })),
  })
}
