import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { supabase } from '../lib/supabase'

export default function DashboardPage() {
  const { session, signOut } = useAuth()
  const navigate = useNavigate()
  const [projects, setProjects] = useState([])
  const [loadingProjects, setLoadingProjects] = useState(true)

  useEffect(() => {
    fetchProjects()
  }, [])

  const fetchProjects = async () => {
    const { data, error } = await supabase
      .from('projects')
      .select('*')
      .order('created_at', { ascending: false })

    if (!error && data) {
      setProjects(data)
    }
    setLoadingProjects(false)
  }

  const handleSignOut = async () => {
    await signOut()
    navigate('/login')
  }

  const formatDate = (iso) =>
    new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

  const formatCost = (cents) =>
    cents != null ? `$${(cents / 100).toFixed(2)}` : '—'

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
          <h2 className="dashboard-title">Your Projects</h2>
          <button className="btn-primary" onClick={() => navigate('/new')}>
            + New Video
          </button>
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
            <p>Create your first video to get started.</p>
            <button className="btn-primary" onClick={() => navigate('/new')}>
              Create First Video
            </button>
          </div>
        ) : (
          <div className="projects-grid">
            {projects.map((project) => (
              <div
                key={project.id}
                className="project-card"
                onClick={() => navigate(`/project/${project.id}`)}
              >
                <div className="project-thumb">
                  {project.thumbnail_url ? (
                    <img src={project.thumbnail_url} alt={project.title} />
                  ) : (
                    <div className="thumb-placeholder">⛩</div>
                  )}
                  <div className="project-status" data-status={project.status}>
                    {project.status}
                  </div>
                </div>
                <div className="project-info">
                  <h4 className="project-title">{project.title || 'Untitled Project'}</h4>
                  <div className="project-meta">
                    <span>{formatDate(project.created_at)}</span>
                    <span>{formatCost(project.cost_cents)}</span>
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
