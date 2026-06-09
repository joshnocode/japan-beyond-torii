import { useState, useEffect, useRef } from 'react'
import { useParams, useSearchParams, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

const API_BASE = import.meta.env.DEV ? 'http://localhost:3000' : ''

export default function ProjectPage() {
  const { id } = useParams()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const autostart = searchParams.get('autostart') === '1'

  const [project, setProject] = useState(null)
  const [scenes, setScenes] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [generating, setGenerating] = useState(false)
  const [currentSceneIdx, setCurrentSceneIdx] = useState(null)
  const generatingRef = useRef(false)

  useEffect(() => {
    loadProject()
  }, [id])

  useEffect(() => {
    if (!loading && autostart && project?.status === 'draft') {
      startImageGeneration()
    }
  }, [loading])

  const loadProject = async () => {
    const [{ data: proj, error: pErr }, { data: sc, error: sErr }] = await Promise.all([
      supabase.from('projects').select('*').eq('id', id).single(),
      supabase.from('scenes').select('*').eq('project_id', id).order('scene_index'),
    ])

    if (pErr || !proj) {
      setError('Project not found.')
      setLoading(false)
      return
    }

    setProject(proj)
    setScenes(sc || [])
    setLoading(false)
  }

  const updateScene = (sceneId, patch) => {
    setScenes((prev) => prev.map((s) => (s.id === sceneId ? { ...s, ...patch } : s)))
  }

  const startImageGeneration = async () => {
    if (generatingRef.current) return
    generatingRef.current = true
    setGenerating(true)
    setError('')

    await supabase.from('projects').update({ status: 'processing' }).eq('id', id)
    setProject((p) => ({ ...p, status: 'processing' }))

    const pending = scenes.filter((s) => !s.image_url)

    for (const scene of pending) {
      if (!generatingRef.current) break
      setCurrentSceneIdx(scene.scene_index)

      await supabase
        .from('scenes')
        .update({ status: 'generating_image' })
        .eq('id', scene.id)
      updateScene(scene.id, { status: 'generating_image' })

      try {
        const res = await fetch(`${API_BASE}/api/generate-image`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image_prompt: scene.image_prompt }),
        })

        if (!res.ok) {
          const { error: msg } = await res.json()
          throw new Error(msg || `Server error ${res.status}`)
        }

        const { image_url } = await res.json()

        await supabase
          .from('scenes')
          .update({ image_url, status: 'complete' })
          .eq('id', scene.id)
        updateScene(scene.id, { image_url, status: 'complete' })

        // Set project thumbnail from first scene
        if (scene.scene_index === 0) {
          await supabase.from('projects').update({ thumbnail_url: image_url }).eq('id', id)
          setProject((p) => ({ ...p, thumbnail_url: image_url }))
        }
      } catch (err) {
        await supabase
          .from('scenes')
          .update({ status: 'error' })
          .eq('id', scene.id)
        updateScene(scene.id, { status: 'error' })
        setError(`Scene ${scene.scene_index + 1} failed: ${err.message}`)
      }
    }

    // Check if all scenes have images
    const { data: finalScenes } = await supabase
      .from('scenes')
      .select('image_url, status')
      .eq('project_id', id)

    const allDone = finalScenes?.every((s) => s.image_url)
    const newStatus = allDone ? 'images_ready' : 'processing'

    await supabase.from('projects').update({ status: newStatus }).eq('id', id)
    setProject((p) => ({ ...p, status: newStatus }))

    generatingRef.current = false
    setGenerating(false)
    setCurrentSceneIdx(null)
  }

  const stopGeneration = () => {
    generatingRef.current = false
  }

  if (loading) {
    return (
      <div className="full-screen-loading">
        <div className="spinner" />
      </div>
    )
  }

  if (!project) {
    return (
      <div className="app-layout">
        <header className="app-header">
          <button className="btn-ghost" onClick={() => navigate('/dashboard')}>← Back</button>
        </header>
        <main className="new-project-main">
          <p className="error-message">{error || 'Project not found.'}</p>
        </main>
      </div>
    )
  }

  const doneCount = scenes.filter((s) => s.image_url).length
  const totalCount = scenes.length
  const progressPct = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0
  const allImagesReady = doneCount === totalCount && totalCount > 0
  const brief = project.brief

  return (
    <div className="app-layout">
      <header className="app-header">
        <div className="header-left">
          <button className="btn-ghost" onClick={() => navigate('/dashboard')}>← Dashboard</button>
          <span className="header-brand-mark">⛩</span>
          <span className="header-brand">{project.title || 'Untitled Project'}</span>
        </div>
        <div className="header-right">
          <span className="project-status-badge" data-status={project.status}>
            {statusLabel(project.status)}
          </span>
        </div>
      </header>

      <main className="project-main">

        {/* ── Generating state ── */}
        {generating && (
          <div className="generation-banner">
            <div className="gen-progress-info">
              <div className="spinner" />
              <div>
                <p className="gen-label">Generating Images</p>
                <p className="gen-detail">
                  Scene {(currentSceneIdx ?? 0) + 1} of {totalCount} — FLUX 1.1 Pro Ultra
                </p>
              </div>
            </div>
            <div className="gen-progress-bar-wrap">
              <div className="gen-progress-bar" style={{ width: `${progressPct}%` }} />
            </div>
            <div className="gen-counts">
              {doneCount} / {totalCount} complete
            </div>
          </div>
        )}

        {/* ── Error ── */}
        {error && <p className="error-message project-error">{error}</p>}

        {/* ── Draft state ── */}
        {project.status === 'draft' && !generating && brief && (
          <div className="draft-panel">
            <div className="draft-header">
              <div>
                <h2>{project.title}</h2>
                <p className="section-subtitle">
                  {brief.scene_count} scenes · ~{Math.round(brief.estimated_duration_seconds / 60)}m · Est. ${brief.cost_estimate?.total_usd?.toFixed(2)}
                </p>
              </div>
              <button className="btn-primary" onClick={startImageGeneration}>
                Generate Images →
              </button>
            </div>
            <p className="tone-summary">{brief.tone_summary}</p>
          </div>
        )}

        {/* ── All images ready ── */}
        {allImagesReady && !generating && (
          <div className="ready-banner">
            <div>
              <p className="ready-label">All {totalCount} images generated</p>
              <p className="ready-sub">Ready to generate video clips from each scene.</p>
            </div>
            <button className="btn-primary" disabled title="Coming in next milestone">
              Generate Videos → <span className="chip">Next</span>
            </button>
          </div>
        )}

        {/* ── Scenes grid ── */}
        <div className="scenes-generation-grid">
          {scenes.map((scene) => {
            const isActive = generating && scene.scene_index === currentSceneIdx
            return (
              <div
                key={scene.id}
                className={`gen-scene-card ${isActive ? 'active' : ''} ${scene.image_url ? 'done' : ''}`}
              >
                <div className="gen-scene-thumb">
                  {scene.image_url ? (
                    <img src={scene.image_url} alt={`Scene ${scene.scene_index + 1}`} />
                  ) : isActive ? (
                    <div className="gen-scene-loading">
                      <div className="spinner" />
                      <p>Generating…</p>
                    </div>
                  ) : (
                    <div className="gen-scene-placeholder">
                      <span>{scene.scene_index + 1}</span>
                    </div>
                  )}
                  {scene.image_url && (
                    <div className="gen-scene-done-badge">✓</div>
                  )}
                  {scene.status === 'error' && (
                    <div className="gen-scene-error-badge">!</div>
                  )}
                </div>
                <div className="gen-scene-info">
                  <p className="gen-scene-label">Scene {scene.scene_index + 1}</p>
                  <p className="gen-scene-desc">{scene.description}</p>
                </div>
              </div>
            )
          })}
        </div>

        {/* ── Brief detail (collapsed) ── */}
        {brief && (
          <details className="brief-detail-section">
            <summary>View full scene brief</summary>
            <div className="brief-detail-body">
              {scenes.map((scene, i) => (
                <div key={scene.id} className="brief-detail-row">
                  <span className="scene-number">Scene {i + 1}</span>
                  <div>
                    <p className="scene-excerpt">"{brief.scenes[i]?.script_excerpt}"</p>
                    <p className="scene-prompt" style={{ marginTop: 6 }}>{scene.image_prompt}</p>
                  </div>
                </div>
              ))}
            </div>
          </details>
        )}
      </main>
    </div>
  )
}

function statusLabel(s) {
  return {
    draft: 'Draft',
    processing: 'Generating…',
    images_ready: 'Images Ready',
    complete: 'Complete',
    error: 'Error',
  }[s] ?? s
}
