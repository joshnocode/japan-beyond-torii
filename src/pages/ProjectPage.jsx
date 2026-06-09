import { useState, useEffect, useRef } from 'react'
import { useParams, useSearchParams, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import AssemblyPanel from '../components/AssemblyPanel'
import AudioUploader from '../components/AudioUploader'

const API_BASE = import.meta.env.DEV ? 'http://localhost:3000' : ''
const POLL_INTERVAL_MS = 5000

export default function ProjectPage() {
  const { id } = useParams()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const autostart = searchParams.get('autostart') === '1'

  const [project, setProject] = useState(null)
  const [scenes, setScenes] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [phase, setPhase] = useState('idle') // idle | images | videos
  const [currentIdx, setCurrentIdx] = useState(null)
  const [currentAction, setCurrentAction] = useState('') // 'Generating image…' | 'Queued' | 'Processing…'
  const activeRef = useRef(false)

  useEffect(() => {
    loadProject()
  }, [id])

  useEffect(() => {
    if (!loading && autostart && project?.status === 'draft') {
      startImageGeneration()
    }
  }, [loading])

  const loadProject = async () => {
    const [{ data: proj }, { data: sc }] = await Promise.all([
      supabase.from('projects').select('*').eq('id', id).single(),
      supabase.from('scenes').select('*').eq('project_id', id).order('scene_index'),
    ])
    if (!proj) { setError('Project not found.'); setLoading(false); return }
    setProject(proj)
    setScenes(sc || [])
    setLoading(false)
  }

  const patchScene = (sceneId, patch) =>
    setScenes((prev) => prev.map((s) => (s.id === sceneId ? { ...s, ...patch } : s)))

  const patchProject = (patch) => setProject((p) => ({ ...p, ...patch }))

  // ── Image generation ─────────────────────────────────────────
  const startImageGeneration = async () => {
    if (activeRef.current) return
    activeRef.current = true
    setPhase('images')
    setError('')

    await supabase.from('projects').update({ status: 'processing' }).eq('id', id)
    patchProject({ status: 'processing' })

    const pending = scenes.filter((s) => !s.image_url)

    for (const scene of pending) {
      if (!activeRef.current) break
      setCurrentIdx(scene.scene_index)
      setCurrentAction('Generating image…')

      await supabase.from('scenes').update({ status: 'generating_image' }).eq('id', scene.id)
      patchScene(scene.id, { status: 'generating_image' })

      try {
        const res = await fetch(`${API_BASE}/api/generate-image`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image_prompt: scene.image_prompt }),
        })
        if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`)
        const { image_url } = await res.json()

        await supabase.from('scenes').update({ image_url, status: 'complete' }).eq('id', scene.id)
        patchScene(scene.id, { image_url, status: 'complete' })

        if (scene.scene_index === 0) {
          await supabase.from('projects').update({ thumbnail_url: image_url }).eq('id', id)
          patchProject({ thumbnail_url: image_url })
        }
      } catch (err) {
        await supabase.from('scenes').update({ status: 'error' }).eq('id', scene.id)
        patchScene(scene.id, { status: 'error' })
        setError(`Scene ${scene.scene_index + 1} image failed: ${err.message}`)
      }
    }

    const allImages = (await supabase.from('scenes').select('image_url').eq('project_id', id)).data
    const newStatus = allImages?.every((s) => s.image_url) ? 'images_ready' : 'processing'
    await supabase.from('projects').update({ status: newStatus }).eq('id', id)
    patchProject({ status: newStatus })

    activeRef.current = false
    setPhase('idle')
    setCurrentIdx(null)
  }

  // ── Video generation ─────────────────────────────────────────
  const startVideoGeneration = async () => {
    if (activeRef.current) return
    activeRef.current = true
    setPhase('videos')
    setError('')

    await supabase.from('projects').update({ status: 'generating_videos' }).eq('id', id)
    patchProject({ status: 'generating_videos' })

    // Use latest scenes state from Supabase (in case images were done in a previous session)
    const { data: freshScenes } = await supabase
      .from('scenes')
      .select('*')
      .eq('project_id', id)
      .order('scene_index')
    const pending = (freshScenes || []).filter((s) => s.image_url && !s.video_url)

    for (const scene of pending) {
      if (!activeRef.current) break
      setCurrentIdx(scene.scene_index)
      setCurrentAction('Submitting to queue…')

      await supabase.from('scenes').update({ status: 'generating_video' }).eq('id', scene.id)
      patchScene(scene.id, { status: 'generating_video' })

      try {
        // Submit
        const submitRes = await fetch(`${API_BASE}/api/submit-video`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            image_url: scene.image_url,
            motion_prompt: scene.motion_prompt,
          }),
        })
        if (!submitRes.ok) throw new Error((await submitRes.json()).error || `HTTP ${submitRes.status}`)
        const { request_id } = await submitRes.json()
        setCurrentAction('In queue…')

        // Poll
        let video_url = null
        while (activeRef.current) {
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
          const pollRes = await fetch(`${API_BASE}/api/poll-video?request_id=${encodeURIComponent(request_id)}`)
          if (!pollRes.ok) throw new Error(`Poll HTTP ${pollRes.status}`)
          const data = await pollRes.json()

          if (data.status === 'in_progress') setCurrentAction('Generating video…')
          if (data.status === 'done') { video_url = data.video_url; break }
          if (data.status === 'error') throw new Error(data.error || 'Video generation failed')
        }

        if (!video_url) throw new Error('No video URL returned')

        await supabase.from('scenes').update({ video_url, status: 'complete' }).eq('id', scene.id)
        patchScene(scene.id, { video_url, status: 'complete' })
      } catch (err) {
        await supabase.from('scenes').update({ status: 'error' }).eq('id', scene.id)
        patchScene(scene.id, { status: 'error' })
        setError(`Scene ${scene.scene_index + 1} video failed: ${err.message}`)
      }
    }

    const allVideos = (await supabase.from('scenes').select('video_url').eq('project_id', id)).data
    const newStatus = allVideos?.every((s) => s.video_url) ? 'videos_ready' : 'generating_videos'
    await supabase.from('projects').update({ status: newStatus }).eq('id', id)
    patchProject({ status: newStatus })

    activeRef.current = false
    setPhase('idle')
    setCurrentIdx(null)
  }

  // ── Delete project ────────────────────────────────────────────
  const handleDelete = async () => {
    if (!window.confirm(`Delete "${project.title || 'this project'}"? This cannot be undone.`)) return
    const prefix = `${project.user_id}/${project.id}`
    const { data: files } = await supabase.storage.from('project-assets').list(prefix)
    if (files?.length) {
      await supabase.storage.from('project-assets').remove(files.map((f) => `${prefix}/${f.name}`))
    }
    await supabase.from('projects').delete().eq('id', project.id)
    navigate('/dashboard')
  }

  // ── Derived state ─────────────────────────────────────────────
  const imgDone = scenes.filter((s) => s.image_url).length
  const vidDone = scenes.filter((s) => s.video_url).length
  const total = scenes.length
  const imgPct = total > 0 ? Math.round((imgDone / total) * 100) : 0
  const vidPct = total > 0 ? Math.round((vidDone / total) * 100) : 0
  const allImagesReady = imgDone === total && total > 0
  const allVideosReady = vidDone === total && total > 0

  if (loading) return <div className="full-screen-loading"><div className="spinner" /></div>

  if (!project) {
    return (
      <div className="app-layout">
        <header className="app-header">
          <button className="btn-ghost" onClick={() => navigate('/dashboard')}>← Back</button>
        </header>
        <main className="project-main">
          <p className="error-message">{error || 'Project not found.'}</p>
        </main>
      </div>
    )
  }

  const brief = project.brief

  return (
    <div className="app-layout">
      <header className="app-header">
        <div className="header-left">
          <button className="btn-ghost" onClick={() => navigate('/dashboard')}>← Dashboard</button>
          <span className="header-brand-mark">⛩</span>
          <span className="header-brand">{project.title || 'Untitled'}</span>
        </div>
        <div className="header-right">
          <span className="project-status-badge" data-status={project.status}>
            {STATUS_LABELS[project.status] ?? project.status}
          </span>
          <button className="btn-ghost btn-danger-ghost" onClick={handleDelete} title="Delete project">
            Delete
          </button>
        </div>
      </header>

      <main className="project-main">

        {/* ── Active progress banner ── */}
        {phase === 'images' && (
          <ProgressBanner
            label="Generating Images"
            detail={`Scene ${(currentIdx ?? 0) + 1} of ${total} — ${currentAction}`}
            pct={imgPct}
            done={imgDone}
            total={total}
          />
        )}
        {phase === 'videos' && (
          <ProgressBanner
            label="Generating Videos"
            detail={`Scene ${(currentIdx ?? 0) + 1} of ${total} — ${currentAction}`}
            pct={vidPct}
            done={vidDone}
            total={total}
          />
        )}

        {/* ── Error ── */}
        {error && <p className="error-message project-error">{error}</p>}

        {/* ── Draft call-to-action ── */}
        {project.status === 'draft' && phase === 'idle' && brief && (
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

        {/* ── Images ready, videos not started ── */}
        {project.status === 'images_ready' && phase === 'idle' && (
          <div className="ready-banner">
            <div>
              <p className="ready-label">✓ All {total} images generated</p>
              <p className="ready-sub">Ready to generate video clips via Seedance 2.0 Fast. Each clip takes ~60–90 s.</p>
            </div>
            <button className="btn-primary" onClick={startVideoGeneration}>
              Generate Videos →
            </button>
          </div>
        )}

        {/* ── Audio upload (when missing and videos are ready) ── */}
        {['videos_ready', 'assembling'].includes(project.status) && !project.audio_url && phase === 'idle' && (
          <AudioUploader
            project={project}
            onUploaded={(url) => patchProject({ audio_url: url })}
          />
        )}

        {/* ── Videos ready / assembly ── */}
        {['videos_ready', 'assembling', 'complete'].includes(project.status) && phase === 'idle' && (
          <AssemblyPanel
            project={project}
            scenes={scenes}
            onComplete={(url) => {
              setProject((p) => ({ ...p, status: 'complete', video_url: url }))
            }}
          />
        )}

        {/* ── Scenes grid ── */}
        <div className="scenes-generation-grid">
          {scenes.map((scene) => {
            const isActive = phase !== 'idle' && scene.scene_index === currentIdx
            return (
              <SceneCard
                key={scene.id}
                scene={scene}
                isActive={isActive}
                activeAction={currentAction}
                phase={phase}
              />
            )
          })}
        </div>

        {/* ── Collapsible brief ── */}
        {brief && (
          <details className="brief-detail-section">
            <summary>View scene prompts</summary>
            <div className="brief-detail-body">
              {scenes.map((scene, i) => (
                <div key={scene.id} className="brief-detail-row">
                  <span className="scene-number">Scene {i + 1}</span>
                  <div>
                    <p className="scene-excerpt">"{brief.scenes[i]?.script_excerpt}"</p>
                    <p className="scene-prompt" style={{ marginTop: 6 }}><strong>Image:</strong> {scene.image_prompt}</p>
                    <p className="scene-prompt" style={{ marginTop: 4 }}><strong>Motion:</strong> {scene.motion_prompt}</p>
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

// ── Sub-components ─────────────────────────────────────────────
function ProgressBanner({ label, detail, pct, done, total }) {
  return (
    <div className="generation-banner">
      <div className="gen-progress-info">
        <div className="spinner" />
        <div>
          <p className="gen-label">{label}</p>
          <p className="gen-detail">{detail}</p>
        </div>
      </div>
      <div className="gen-progress-bar-wrap">
        <div className="gen-progress-bar" style={{ width: `${pct}%` }} />
      </div>
      <div className="gen-counts">{done} / {total} complete</div>
    </div>
  )
}

function SceneCard({ scene, isActive, activeAction, phase }) {
  const hasVideo = !!scene.video_url
  const hasImage = !!scene.image_url
  const isImgActive = isActive && phase === 'images'
  const isVidActive = isActive && phase === 'videos'

  return (
    <div className={`gen-scene-card ${isActive ? 'active' : ''} ${hasVideo ? 'has-video' : hasImage ? 'done' : ''}`}>
      <div className="gen-scene-thumb">
        {hasVideo ? (
          <video
            src={scene.video_url}
            loop
            muted
            playsInline
            autoPlay
            className="scene-video"
          />
        ) : hasImage ? (
          <>
            <img src={scene.image_url} alt={`Scene ${scene.scene_index + 1}`} />
            {isVidActive && (
              <div className="gen-scene-video-overlay">
                <div className="spinner" />
                <p>{activeAction}</p>
              </div>
            )}
          </>
        ) : isImgActive ? (
          <div className="gen-scene-loading">
            <div className="spinner" />
            <p>{activeAction}</p>
          </div>
        ) : (
          <div className="gen-scene-placeholder">
            <span>{scene.scene_index + 1}</span>
          </div>
        )}

        {hasVideo && <div className="gen-scene-done-badge video">▶</div>}
        {!hasVideo && hasImage && <div className="gen-scene-done-badge">✓</div>}
        {scene.status === 'error' && <div className="gen-scene-error-badge">!</div>}
      </div>
      <div className="gen-scene-info">
        <p className="gen-scene-label">Scene {scene.scene_index + 1}</p>
        <p className="gen-scene-desc">{scene.description}</p>
      </div>
    </div>
  )
}

const STATUS_LABELS = {
  draft: 'Draft',
  processing: 'Generating Images…',
  images_ready: 'Images Ready',
  generating_videos: 'Generating Videos…',
  videos_ready: 'Videos Ready',
  assembling: 'Assembling…',
  complete: 'Complete',
  error: 'Error',
}
