import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useSearchParams, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import AssemblyPanel from '../components/AssemblyPanel'
import AudioUploader from '../components/AudioUploader'

const API_BASE = import.meta.env.DEV ? 'http://localhost:3000' : ''
const POLL_INTERVAL_MS = 5000
const VIDEO_TIMEOUT_MS = 3 * 60 * 1000  // 3 minutes before retry
const MAX_VIDEO_RETRIES = 2

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

export default function ProjectPage() {
  const { id } = useParams()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const autostart = searchParams.get('autostart') === '1'

  const [project, setProject]   = useState(null)
  const [scenes, setScenes]     = useState([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState('')
  const [phase, setPhase]       = useState('idle')      // idle | images | videos
  const [currentIdx, setCurrentIdx] = useState(null)
  const [currentAction, setCurrentAction] = useState('')
  const [avgSceneMs, setAvgSceneMs] = useState(null)    // for ETA
  const [elapsedSeconds, setElapsedSeconds] = useState(0)

  const activeRef     = useRef(false)
  const sceneTimesRef = useRef([])
  const sceneStartRef = useRef(null)

  // ── Elapsed timer ─────────────────────────────────────────────
  useEffect(() => {
    if (phase === 'idle') { setElapsedSeconds(0); return }
    const id = setInterval(() => {
      if (sceneStartRef.current) {
        setElapsedSeconds(Math.floor((Date.now() - sceneStartRef.current) / 1000))
      }
    }, 1000)
    return () => clearInterval(id)
  }, [phase])

  useEffect(() => { loadProject() }, [id])

  useEffect(() => {
    if (!loading && autostart && project?.status === 'draft') startImageGeneration()
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

  const patchScene   = (sceneId, patch) => setScenes(prev => prev.map(s => s.id === sceneId ? { ...s, ...patch } : s))
  const patchProject = (patch) => setProject(p => ({ ...p, ...patch }))

  // ── Video polling with 3-min timeout + retry ─────────────────
  const pollVideoWithRetry = useCallback(async (scene) => {
    let lastErr
    for (let attempt = 0; attempt <= MAX_VIDEO_RETRIES; attempt++) {
      if (attempt > 0) {
        setCurrentAction(`Retry ${attempt}/${MAX_VIDEO_RETRIES}…`)
        await new Promise(r => setTimeout(r, 3000))
      }
      try {
        setCurrentAction(attempt === 0 ? 'Submitting…' : `Retrying (${attempt}/${MAX_VIDEO_RETRIES})…`)

        const submitRes = await fetch(`${API_BASE}/api/submit-video`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image_url: scene.image_url, motion_prompt: scene.motion_prompt }),
        })
        if (!submitRes.ok) throw new Error((await submitRes.json()).error || `HTTP ${submitRes.status}`)
        const { request_id } = await submitRes.json()
        setCurrentAction('In queue…')

        const deadline = Date.now() + VIDEO_TIMEOUT_MS
        while (activeRef.current) {
          await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
          if (Date.now() > deadline) throw new Error('Timed out after 3 minutes')

          const pollRes = await fetch(`${API_BASE}/api/poll-video?request_id=${encodeURIComponent(request_id)}`)
          if (!pollRes.ok) throw new Error(`Poll HTTP ${pollRes.status}`)
          const data = await pollRes.json()

          if (data.status === 'in_progress') setCurrentAction('Animating…')
          if (data.status === 'done') return data.video_url
          if (data.status === 'error') throw new Error(data.error || 'Video generation failed')
        }
        return null  // user navigated away
      } catch (err) {
        lastErr = err
        if (!activeRef.current) return null
      }
    }
    throw lastErr
  }, [])

  // ── Image generation ──────────────────────────────────────────
  const startImageGeneration = async () => {
    if (activeRef.current) return
    activeRef.current = true
    setPhase('images')
    setError('')
    sceneTimesRef.current = []

    await supabase.from('projects').update({ status: 'processing' }).eq('id', id)
    patchProject({ status: 'processing' })

    const pending = scenes.filter(s => !s.image_url)
    for (const scene of pending) {
      if (!activeRef.current) break
      setCurrentIdx(scene.scene_index)
      setCurrentAction('Generating image…')
      sceneStartRef.current = Date.now()
      setElapsedSeconds(0)

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

        const t = Date.now() - sceneStartRef.current
        const times = [...sceneTimesRef.current, t]
        sceneTimesRef.current = times
        setAvgSceneMs(times.reduce((a, b) => a + b, 0) / times.length)

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

    const { data: allImages } = await supabase.from('scenes').select('image_url').eq('project_id', id)
    const newStatus = allImages?.every(s => s.image_url) ? 'images_ready' : 'processing'
    await supabase.from('projects').update({ status: newStatus }).eq('id', id)
    patchProject({ status: newStatus })

    activeRef.current = false
    setPhase('idle')
    setCurrentIdx(null)
    sceneStartRef.current = null
  }

  // ── Video generation ──────────────────────────────────────────
  const startVideoGeneration = async () => {
    if (activeRef.current) return
    activeRef.current = true
    setPhase('videos')
    setError('')
    sceneTimesRef.current = []
    setAvgSceneMs(null)

    await supabase.from('projects').update({ status: 'generating_videos' }).eq('id', id)
    patchProject({ status: 'generating_videos' })

    const { data: freshScenes } = await supabase
      .from('scenes').select('*').eq('project_id', id).order('scene_index')
    const pending = (freshScenes || []).filter(s => s.image_url && !s.video_url)

    for (const scene of pending) {
      if (!activeRef.current) break
      setCurrentIdx(scene.scene_index)
      setCurrentAction('Submitting…')
      sceneStartRef.current = Date.now()
      setElapsedSeconds(0)

      await supabase.from('scenes').update({ status: 'generating_video' }).eq('id', scene.id)
      patchScene(scene.id, { status: 'generating_video' })

      try {
        const video_url = await pollVideoWithRetry(scene)
        if (!video_url && !activeRef.current) break

        const t = Date.now() - sceneStartRef.current
        const times = [...sceneTimesRef.current, t]
        sceneTimesRef.current = times
        setAvgSceneMs(times.reduce((a, b) => a + b, 0) / times.length)

        await supabase.from('scenes').update({ video_url, status: 'complete' }).eq('id', scene.id)
        patchScene(scene.id, { video_url, status: 'complete' })
      } catch (err) {
        await supabase.from('scenes').update({ status: 'error' }).eq('id', scene.id)
        patchScene(scene.id, { status: 'error' })
        setError(`Scene ${scene.scene_index + 1} failed after ${MAX_VIDEO_RETRIES} retries: ${err.message}`)
        // Continue to next scene — don't block
      }
    }

    const { data: allVideos } = await supabase.from('scenes').select('video_url, status').eq('project_id', id)
    const allHaveVideo = allVideos?.every(s => s.video_url || s.status === 'error')
    const anyVideo     = allVideos?.some(s => s.video_url)
    const newStatus    = anyVideo && allHaveVideo ? 'videos_ready' : 'generating_videos'
    await supabase.from('projects').update({ status: newStatus }).eq('id', id)
    patchProject({ status: newStatus })

    activeRef.current = false
    setPhase('idle')
    setCurrentIdx(null)
    sceneStartRef.current = null
  }

  // ── Single-scene retry ────────────────────────────────────────
  const retrySingleScene = useCallback(async (scene) => {
    if (activeRef.current) return
    activeRef.current = true
    setPhase('videos')
    setCurrentIdx(scene.scene_index)
    setCurrentAction('Retrying…')
    sceneStartRef.current = Date.now()
    setElapsedSeconds(0)
    setError('')

    await supabase.from('scenes').update({ status: 'generating_video' }).eq('id', scene.id)
    patchScene(scene.id, { status: 'generating_video' })

    try {
      const video_url = await pollVideoWithRetry(scene)
      if (video_url) {
        await supabase.from('scenes').update({ video_url, status: 'complete' }).eq('id', scene.id)
        patchScene(scene.id, { video_url, status: 'complete' })

        const { data: allVideos } = await supabase.from('scenes').select('video_url, status').eq('project_id', id)
        const allDone = allVideos?.every(s => s.video_url || s.status === 'error')
        const anyVideo = allVideos?.some(s => s.video_url)
        if (anyVideo && allDone) {
          await supabase.from('projects').update({ status: 'videos_ready' }).eq('id', id)
          patchProject({ status: 'videos_ready' })
        }
      }
    } catch (err) {
      await supabase.from('scenes').update({ status: 'error' }).eq('id', scene.id)
      patchScene(scene.id, { status: 'error' })
      setError(`Retry failed for scene ${scene.scene_index + 1}: ${err.message}`)
    }

    activeRef.current = false
    setPhase('idle')
    setCurrentIdx(null)
    sceneStartRef.current = null
  }, [id, pollVideoWithRetry])

  const handleDelete = async () => {
    if (!window.confirm(`Delete "${project.title || 'this project'}"? This cannot be undone.`)) return
    const prefix = `${project.user_id}/${project.id}`
    const { data: files } = await supabase.storage.from('project-assets').list(prefix)
    if (files?.length) {
      await supabase.storage.from('project-assets').remove(files.map(f => `${prefix}/${f.name}`))
    }
    await supabase.from('projects').delete().eq('id', project.id)
    navigate('/dashboard')
  }

  // ── Derived state ─────────────────────────────────────────────
  const imgDone = scenes.filter(s => s.image_url).length
  const vidDone = scenes.filter(s => s.video_url).length
  const total   = scenes.length
  const imgPct  = total > 0 ? Math.round((imgDone / total) * 100) : 0
  const vidPct  = total > 0 ? Math.round((vidDone / total) * 100) : 0

  const formatEta = (remainingScenes) => {
    if (!avgSceneMs || remainingScenes <= 0) return null
    const etaSec = Math.round((remainingScenes * avgSceneMs) / 1000)
    if (etaSec < 60) return `~${etaSec}s`
    return `~${Math.ceil(etaSec / 60)}m`
  }

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
          <button className="btn-ghost btn-danger-ghost" onClick={handleDelete}>Delete</button>
        </div>
      </header>

      <main className="project-main">

        {/* ── Step tracker ── */}
        <StepTracker project={project} phase={phase} />

        {/* ── Active progress banner ── */}
        {phase === 'images' && (
          <ProgressBanner
            step={`Generating Images`}
            detail={`Scene ${(currentIdx ?? 0) + 1} of ${total} — ${currentAction}${elapsedSeconds > 3 ? ` (${elapsedSeconds}s)` : ''}`}
            pct={imgPct}
            done={imgDone}
            total={total}
            eta={formatEta(total - imgDone)}
          />
        )}
        {phase === 'videos' && (
          <ProgressBanner
            step={`Animating Scene ${(currentIdx ?? 0) + 1} of ${total}`}
            detail={`${currentAction}${elapsedSeconds > 3 ? ` — ${elapsedSeconds}s elapsed` : ''}`}
            pct={vidPct}
            done={vidDone}
            total={total}
            eta={formatEta(total - vidDone - 1)}
          />
        )}

        {/* ── Errors ── */}
        {error && <p className="error-message project-error">{error}</p>}

        {/* ── Draft CTA ── */}
        {project.status === 'draft' && phase === 'idle' && brief && (
          <div className="draft-panel">
            <div className="draft-header">
              <div>
                <h2>{project.title}</h2>
                <p className="section-subtitle">
                  {brief.scene_count} scenes · ~{Math.round(brief.estimated_duration_seconds / 60)}m · Est. ${brief.cost_estimate?.total_usd?.toFixed(2)}
                </p>
              </div>
              <button className="btn-primary" onClick={startImageGeneration}>Generate Images →</button>
            </div>
            <p className="tone-summary">{brief.tone_summary}</p>
          </div>
        )}

        {/* ── Images ready ── */}
        {project.status === 'images_ready' && phase === 'idle' && (
          <div className="ready-banner">
            <div>
              <p className="ready-label">✓ All {total} images generated</p>
              <p className="ready-sub">Ready to generate video clips via Seedance 2.0 Fast. Each clip takes ~2 min.</p>
            </div>
            <button className="btn-primary" onClick={startVideoGeneration}>Animate Scenes →</button>
          </div>
        )}

        {/* ── Audio upload ── */}
        {['videos_ready', 'assembling'].includes(project.status) && !project.audio_url && phase === 'idle' && (
          <AudioUploader project={project} onUploaded={url => patchProject({ audio_url: url })} />
        )}

        {/* ── Assembly ── */}
        {['videos_ready', 'assembling', 'complete'].includes(project.status) && phase === 'idle' && (
          <AssemblyPanel
            project={project}
            scenes={scenes}
            onComplete={url => setProject(p => ({ ...p, status: 'complete', video_url: url }))}
          />
        )}

        {/* ── Scenes grid ── */}
        <div className="scenes-generation-grid">
          {scenes.map(scene => (
            <SceneCard
              key={scene.id}
              scene={scene}
              isActive={phase !== 'idle' && scene.scene_index === currentIdx}
              activeAction={currentAction}
              phase={phase}
              idlePhase={phase === 'idle'}
              onRetry={retrySingleScene}
            />
          ))}
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
                    <p className="scene-excerpt">"{brief.scenes?.[i]?.script_excerpt}"</p>
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

// ── Step tracker ───────────────────────────────────────────────
const STEPS = [
  { key: 'script',   label: 'Script Analyzed' },
  { key: 'images',   label: 'Generating Images' },
  { key: 'videos',   label: 'Animating Scenes' },
  { key: 'assembly', label: 'Assembling Video' },
]

function getActiveStep(status, phase) {
  if (status === 'complete') return 'done'
  if (status === 'assembling') return 'assembly'
  if (['videos_ready', 'generating_videos'].includes(status) || phase === 'videos') return 'videos'
  if (['images_ready', 'processing'].includes(status) || phase === 'images') return 'images'
  return 'script'
}

function StepTracker({ project, phase }) {
  const active = getActiveStep(project.status, phase)
  const stepKeys = STEPS.map(s => s.key)
  const activeIdx = active === 'done' ? stepKeys.length : stepKeys.indexOf(active)

  return (
    <div className="step-tracker">
      {STEPS.map((step, i) => {
        const done    = i < activeIdx || active === 'done'
        const current = i === activeIdx && active !== 'done'
        return (
          <div key={step.key} className={`step-item ${done ? 'done' : current ? 'active' : 'pending'}`}>
            <div className="step-dot">
              {done ? '✓' : current ? <span className="step-spinner" /> : i + 1}
            </div>
            <span className="step-label">{step.label}</span>
            {i < STEPS.length - 1 && <div className={`step-connector ${done ? 'done' : ''}`} />}
          </div>
        )
      })}
    </div>
  )
}

// ── Progress banner ────────────────────────────────────────────
function ProgressBanner({ step, detail, pct, done, total, eta }) {
  return (
    <div className="generation-banner">
      <div className="gen-progress-info">
        <div className="spinner" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <p className="gen-step">{step}</p>
          <p className="gen-detail">{detail}</p>
        </div>
        {eta && <span className="gen-eta">{eta} left</span>}
      </div>
      <div className="gen-progress-bar-wrap">
        <div className="gen-progress-bar" style={{ width: `${pct}%` }} />
      </div>
      <div className="gen-counts">{done} / {total} complete · {pct}%</div>
    </div>
  )
}

// ── Scene card ─────────────────────────────────────────────────
function SceneCard({ scene, isActive, activeAction, phase, idlePhase, onRetry }) {
  const hasVideo = !!scene.video_url
  const hasImage = !!scene.image_url
  const isError  = scene.status === 'error'
  const isImgActive = isActive && phase === 'images'
  const isVidActive = isActive && phase === 'videos'

  return (
    <div className={`gen-scene-card ${isActive ? 'active' : ''} ${hasVideo ? 'has-video' : hasImage ? 'done' : ''} ${isError ? 'has-error' : ''}`}>
      <div className="gen-scene-thumb">
        {hasVideo ? (
          <video src={scene.video_url} loop muted playsInline autoPlay className="scene-video" />
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

        {hasVideo && !isError && <div className="gen-scene-done-badge video">▶</div>}
        {!hasVideo && hasImage && !isError && <div className="gen-scene-done-badge">✓</div>}

        {isError && (
          <div className="gen-scene-error-overlay">
            <span className="error-x">✕</span>
            <p>Failed</p>
            {idlePhase && (
              <button className="scene-retry-btn" onClick={() => onRetry(scene)}>↺ Retry</button>
            )}
          </div>
        )}
      </div>
      <div className="gen-scene-info">
        <p className="gen-scene-label">
          Scene {scene.scene_index + 1}
          {isError && <span className="scene-error-tag">Error</span>}
        </p>
        <p className="gen-scene-desc">{scene.description}</p>
      </div>
    </div>
  )
}
