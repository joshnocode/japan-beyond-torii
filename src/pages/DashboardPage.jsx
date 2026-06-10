import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { supabase } from '../lib/supabase'

const STATUS_LABELS = {
  draft: 'Draft',
  processing: 'Generating Images',
  images_ready: 'Images Ready',
  generating_videos: 'Generating Videos',
  videos_ready: 'Videos Ready',
  assembling: 'Assembling',
  complete: 'Complete',
  error: 'Error',
}

export default function DashboardPage() {
  const { session, signOut } = useAuth()
  const navigate = useNavigate()
  const [projects, setProjects] = useState([])
  const [loadingProjects, setLoadingProjects] = useState(true)
  const [deletingId, setDeletingId] = useState(null)

  useEffect(() => { fetchProjects() }, [])

  const fetchProjects = async () => {
    const { data } = await supabase
      .from('projects')
      .select('*')
      .order('created_at', { ascending: false })
    setProjects(data || [])
    setLoadingProjects(false)
  }

  const handleSignOut = async () => {
    await signOut()
    navigate('/login')
  }

  const handleDelete = async (e, project) => {
    e.stopPropagation()
    if (!window.confirm(`Delete "${project.title || 'Untitled Project'}"? This cannot be undone.`)) return

    setDeletingId(project.id)
    try {
      // Best-effort: remove storage objects
      const prefix = `${project.user_id}/${project.id}`
      const { data: files } = await supabase.storage.from('project-assets').list(prefix)
      if (files?.length) {
        const paths = files.map((f) => `${prefix}/${f.name}`)
        await supabase.storage.from('project-assets').remove(paths)
      }
      // Delete record (scenes cascade)
      await supabase.from('projects').delete().eq('id', project.id)
      setProjects((prev) => prev.filter((p) => p.id !== project.id))
    } finally {
      setDeletingId(null)
    }
  }

  const fmt = (iso) =>
    new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

  const fmtCost = (cents) => (cents != null ? `$${(cents / 100).toFixed(2)}` : '—')

  const totalSpend = projects.reduce((sum, p) => sum + (p.cost_cents || 0), 0)
  const completeCount = projects.filter((p) => p.status === 'complete').length

  return (
    <div className="app-layout">
      <header className="app-header">
        <div className="header-left">
          <span className="header-brand-mark">⛩</span>
          <span className="header-brand">Japan Beyond The Torii</span>
        </div>
        <div className="header-right">
          <span className="header-email">{session?.user?.email}</span>
          <button className="btn-ghost" onClick={handleSignOut}>Sign Out</button>
        </div>
      </header>

      <main className="dashboard-main">
        <div className="dashboard-hero">
          <div>
            <h2 className="dashboard-title">Your Projects</h2>
            {projects.length > 0 && (
              <p className="dashboard-subtitle">
                {projects.length} project{projects.length !== 1 ? 's' : ''} · {completeCount} complete · {fmtCost(totalSpend)} total spent
              </p>
            )}
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn-ghost" onClick={() => navigate('/import')}>
              Import JSON
            </button>
            <button className="btn-primary" onClick={() => navigate('/new')}>
              + New Video
            </button>
          </div>
        </div>

        {loadingProjects ? (
          <div className="loading-state">
            <div className="spinner" />
            <p>Loading projects…</p>
          </div>
        ) : projects.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">🎬</div>
            <h3>No projects yet</h3>
            <p>Paste a script and generate your first cinematic video.</p>
            <button className="btn-primary" onClick={() => navigate('/new')}>
              Create First Video
            </button>
          </div>
        ) : (
          <div className="projects-grid">
            {projects.map((project) => (
              <div
                key={project.id}
                className={`project-card ${deletingId === project.id ? 'deleting' : ''}`}
                onClick={() => navigate(`/project/${project.id}`)}
              >
                <div className="project-thumb">
                  {project.thumbnail_url ? (
                    <img src={project.thumbnail_url} alt={project.title} />
                  ) : (
                    <div className="thumb-placeholder">⛩</div>
                  )}

                  <div className="project-status" data-status={project.status}>
                    {STATUS_LABELS[project.status] ?? project.status}
                  </div>

                  {/* Download overlay for complete projects */}
                  {project.status === 'complete' && project.video_url && (
                    <a
                      href={project.video_url}
                      download
                      target="_blank"
                      rel="noreferrer"
                      className="project-download-overlay"
                      onClick={(e) => e.stopPropagation()}
                      title="Download MP4"
                    >
                      ↓
                    </a>
                  )}
                </div>

                <div className="project-info">
                  <h4 className="project-title">{project.title || 'Untitled Project'}</h4>
                  <div className="project-meta">
                    <span>{fmt(project.created_at)}</span>
                    <span className="project-meta-right">
                      <span className="project-cost">{fmtCost(project.cost_cents)}</span>
                      <button
                        className="project-delete-btn"
                        onClick={(e) => handleDelete(e, project)}
                        title="Delete project"
                        disabled={deletingId === project.id}
                      >
                        {deletingId === project.id ? '…' : '✕'}
                      </button>
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
