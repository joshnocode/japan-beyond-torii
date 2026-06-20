import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useSearchParams, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import AssemblyPanel from '../components/AssemblyPanel'
import AudioUploader from '../components/AudioUploader'

const API_BASE = import.meta.env.DEV ? 'http://localhost:3000' : ''
const POLL_INTERVAL_MS = 5000
const MAX_IMAGE_RETRIES = 4

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
  const [avgSceneMs, setAvgSceneMs] = useState(null)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [generatingAudio, setGeneratingAudio] = useState(false)
  const [audioError, setAudioError] = useState('')

  const activeRef     = useRef(false)
  const sceneTimesRef = useRef([])
  const sceneStartRef = useRef(null)

  // ── Elapsed timer ─────────────────────────────────────────────
  useEffect(() => {
    if (phase === 'idle') { setElapsedSeconds(0); return }
    const tid = setInterval(() => {
      if (sceneStartRef.current) {
        setElapsedSeconds(Math.floor((Date.now() - sceneStartRef.current) / 1000))
      }
    }, 1000)
    return () => clearInterval(tid)
  }, [phase])

  useEffect(() => { loadProject() }, [id])

  // Auto-start (new project) or auto-resume (video polling after refresh)
  useEffect(() => {
    if (loading) return
    if (autostart && project?.status === 'draft') { startImageGeneration(); return }
    // Auto-resume cloud video polling when jobs already submitted
    if (!activeRef.current && project?.status === 'generating_videos') {
      if (scenes.some(s => s.video_request_id && !s.video_url)) {
        activeRef.current = true
        pollPendingVideos()
      } else if (scenes.some(s => s.image_url && !s.video_url && !s.video_request_id)) {
        startVideoGeneration()
      }
    }
  }, [loading])

  // Warn before leaving while image generation is running (client-side loop)
  useEffect(() => {
    const handler = (e) => {
      if (phase !== 'idle') {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [phase])

  const loadProject = async () => {
    try {
      const [{ data: proj, error: projErr }, { data: sc }] = await Promise.all([
        supabase.from('projects').select('*').eq('id', id).single(),
        supabase.from('scenes').select('*').eq('project_id', id).order('scene_index'),
      ])
      if (projErr || !proj) { setError('Project not found.'); setLoading(false); return }
      setProject(proj)
      setScenes(sc || [])
    } catch (err) {
      setError('Failed to load project. Please refresh.')
    } finally {
      setLoading(false)
    }
  }

  const patchScene   = (sceneId, patch) => setScenes(prev => prev.map(s => s.id === sceneId ? { ...s, ...patch } : s))
  const patchProject = (patch) => setProject(p => ({ ...p, ...patch }))

  // ── Image generation with auto-retry ─────────────────────────
  const generateImageWithRetry = useCallback(async (scene) => {
    let lastErr
    for (let attempt = 0; attempt <= MAX_IMAGE_RETRIES; attempt++) {
      if (attempt > 0) {
        setCurrentAction(`Retry ${attempt}/${MAX_IMAGE_RETRIES}…`)
        await new Promise(r => setTimeout(r, 2000))
      }
      try {
        setCurrentAction(attempt === 0 ? 'Generating image…' : `Retrying (${attempt}/${MAX_IMAGE_RETRIES})…`)
        const res = await fetch(`${API_BASE}/api/generate-image`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image_prompt: scene.image_prompt }),
        })
        if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`)
        const { image_url } = await res.json()
        return image_url
      } catch (err) {
        lastErr = err
      }
    }
    throw lastErr
  }, [])

  // ── Cloud video polling — polls all queued request_ids until done ──
  const pollPendingVideos = useCallback(async () => {
    setPhase('videos')

    while (activeRef.current) {
      const { data: pending } = await supabase
        .from('scenes')
        .select('id, scene_index, video_request_id')
        .eq('project_id', id)
        .not('video_request_id', 'is', null)
        .is('video_url', null)

      if (!pending?.length) break

      setCurrentAction(`Polling ${pending.length} scene${pending.length !== 1 ? 's' : ''}…`)

      // Poll all in parallel — cloud jobs run concurrently, so we check them all each cycle
      await Promise.all(
        pending.map(async (scene) => {
          try {
            const pollRes = await fetch(
              `${API_BASE}/api/poll-video?request_id=${encodeURIComponent(scene.video_request_id)}`
            )
            if (!pollRes.ok) return
            const data = await pollRes.json()

            if (data.status === 'done' && data.video_url) {
              await supabase.from('scenes')
                .update({ video_url: data.video_url, status: 'complete', video_request_id: null })
                .eq('id', scene.id)
              setScenes(prev => prev.map(s =>
                s.id === scene.id ? { ...s, video_url: data.video_url, status: 'complete', video_request_id: null } : s
              ))
            } else if (data.status === 'error') {
              await supabase.from('scenes')
                .update({ status: 'error', video_request_id: null })
                .eq('id', scene.id)
              setScenes(prev => prev.map(s =>
                s.id === scene.id ? { ...s, status: 'error', video_request_id: null } : s
              ))
            }
            // 'queued' / 'in_progress' → do nothing, retry next cycle
          } catch (_) {}
        })
      )

      if (!activeRef.current) break
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
    }

    const { data: allScenes } = await supabase
      .from('scenes').select('video_url, image_url').eq('project_id', id)
    // Only advance when every scene that has an image also has a video
    const allHaveVideo = allScenes?.every(s => !s.image_url || s.video_url)
    const newStatus = allHaveVideo ? 'videos_ready' : 'generating_videos'

    // Guard: don't overwrite assembling/complete if the user started assembly
    // while this poll loop was still running (race condition)
    await supabase.from('projects')
      .update({ status: newStatus })
      .eq('id', id)
      .eq('status', 'generating_videos')
    setProject(p => (p.status === 'generating_videos' ? { ...p, status: newStatus } : p))

    activeRef.current = false
    setPhase('idle')
    setCurrentIdx(null)
    sceneStartRef.current = null
  }, [id])

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
        const image_url = await generateImageWithRetry(scene)

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

    if (newStatus === 'images_ready') await startVideoGeneration()
  }

  // ── Video generation — fan-out submit to cloud, then poll ────
  const startVideoGeneration = async () => {
    if (activeRef.current) return
    activeRef.current = true
    setPhase('videos')
    setError('')
    sceneTimesRef.current = []
    setAvgSceneMs(null)
    setCurrentIdx(null)
    setCurrentAction('Submitting scenes to cloud…')

    await supabase.from('projects').update({ status: 'generating_videos' }).eq('id', id)
    patchProject({ status: 'generating_videos' })

    const { data: freshScenes } = await supabase
      .from('scenes').select('*').eq('project_id', id).order('scene_index')

    // Only submit scenes not yet queued
    const toSubmit = (freshScenes || []).filter(s => s.image_url && !s.video_url && !s.video_request_id)

    if (toSubmit.length > 0) {
      const submitRes = await fetch(`${API_BASE}/api/submit-all-videos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scenes: toSubmit.map(s => ({ id: s.id, image_url: s.image_url, motion_prompt: s.motion_prompt })),
        }),
      })

      if (!submitRes.ok) {
        setError('Failed to submit video jobs to cloud. Please try again.')
        activeRef.current = false
        setPhase('idle')
        return
      }

      const { submitted, failed } = await submitRes.json()

      // Persist request_ids so polling survives refresh
      await Promise.all(
        submitted.map(({ scene_id, request_id }) =>
          supabase.from('scenes')
            .update({ video_request_id: request_id, status: 'generating_video' })
            .eq('id', scene_id)
        )
      )
      submitted.forEach(({ scene_id, request_id }) =>
        patchScene(scene_id, { video_request_id: request_id, status: 'generating_video' })
      )

      if (failed > 0) {
        const submittedIds = new Set(submitted.map(s => s.scene_id))
        const failedScenes = toSubmit.filter(s => !submittedIds.has(s.id))
        await Promise.all(failedScenes.map(s =>
          supabase.from('scenes').update({ status: 'error' }).eq('id', s.id)
        ))
        failedScenes.forEach(s => patchScene(s.id, { status: 'error' }))
        setError(`${failed} scene${failed > 1 ? 's' : ''} failed to submit.`)
      }
    }

    await pollPendingVideos()
  }

  // ── Single-scene image retry ──────────────────────────────────
  const retrySingleImage = useCallback(async (scene) => {
    if (activeRef.current) return
    activeRef.current = true
    setPhase('images')
    setCurrentIdx(scene.scene_index)
    setCurrentAction('Generating image…')
    sceneStartRef.current = Date.now()
    setElapsedSeconds(0)
    setError('')

    await supabase.from('scenes').update({ status: 'generating_image' }).eq('id', scene.id)
    patchScene(scene.id, { status: 'generating_image' })

    try {
      const image_url = await generateImageWithRetry(scene)

      await supabase.from('scenes').update({ image_url, status: 'complete' }).eq('id', scene.id)
      patchScene(scene.id, { image_url, status: 'complete' })

      if (scene.scene_index === 0) {
        await supabase.from('projects').update({ thumbnail_url: image_url }).eq('id', id)
        patchProject({ thumbnail_url: image_url })
      }

      const { data: allImages } = await supabase.from('scenes').select('image_url').eq('project_id', id)
      const allReady = allImages?.every(s => s.image_url)
      if (allReady) {
        await supabase.from('projects').update({ status: 'images_ready' }).eq('id', id)
        patchProject({ status: 'images_ready' })
      }

      activeRef.current = false
      setPhase('idle')
      setCurrentIdx(null)
      sceneStartRef.current = null

      if (allReady) await startVideoGeneration()
      return
    } catch (err) {
      await supabase.from('scenes').update({ status: 'error' }).eq('id', scene.id)
      patchScene(scene.id, { status: 'error' })
      setError(`Scene ${scene.scene_index + 1} image retry failed: ${err.message}`)
    }

    activeRef.current = false
    setPhase('idle')
    setCurrentIdx(null)
    sceneStartRef.current = null
  }, [id, generateImageWithRetry])

  // ── Single-scene video retry — submit to cloud + poll ────────
  const retrySingleScene = useCallback(async (scene) => {
    if (activeRef.current) return
    activeRef.current = true
    setPhase('videos')
    setCurrentIdx(scene.scene_index)
    setCurrentAction('Submitting…')
    sceneStartRef.current = Date.now()
    setElapsedSeconds(0)
    setError('')

    await supabase.from('scenes').update({ status: 'generating_video', video_request_id: null }).eq('id', scene.id)
    setScenes(prev => prev.map(s => s.id === scene.id ? { ...s, status: 'generating_video', video_request_id: null } : s))

    try {
      const submitRes = await fetch(`${API_BASE}/api/submit-all-videos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenes: [{ id: scene.id, image_url: scene.image_url, motion_prompt: scene.motion_prompt }] }),
      })
      if (!submitRes.ok) throw new Error((await submitRes.json()).error || `HTTP ${submitRes.status}`)
      const { submitted } = await submitRes.json()
      if (!submitted?.length) throw new Error('Job submission failed')

      const { request_id } = submitted[0]
      await supabase.from('scenes').update({ video_request_id: request_id }).eq('id', scene.id)
      setScenes(prev => prev.map(s => s.id === scene.id ? { ...s, video_request_id: request_id } : s))

      setCurrentIdx(null)
      await pollPendingVideos()
    } catch (err) {
      await supabase.from('scenes').update({ status: 'error' }).eq('id', scene.id)
      setScenes(prev => prev.map(s => s.id === scene.id ? { ...s, status: 'error' } : s))
      setError(`Retry failed for scene ${scene.scene_index + 1}: ${err.message}`)
      activeRef.current = false
      setPhase('idle')
      setCurrentIdx(null)
      sceneStartRef.current = null
    }
  }, [id, pollPendingVideos])

  const handleSceneRetry = useCallback((scene) => {
    if (!scene.image_url) return retrySingleImage(scene)
    return retrySingleScene(scene)
  }, [retrySingleImage, retrySingleScene])

  const generateAudio = async () => {
    setGeneratingAudio(true)
    setAudioError('')
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch(`${API_BASE}/api/generate-audio`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ project_id: id }),
      })
      const body = await res.json()
      if (!res.ok || body.error) throw new Error(body.error || `Server error ${res.status}`)
      patchProject({ audio_url: body.audio_url })
    } catch (err) {
      setAudioError(err.message || 'Audio generation failed')
    } finally {
      setGeneratingAudio(false)
    }
  }

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

  // ── Derived state ─────────────────────────────────────────────
  const imgDone = scenes.filter(s => s.image_url).length
  const vidDone = scenes.filter(s => s.video_url).length
  const total   = scenes.length
  const imgPct  = total > 0 ? Math.round((imgDone / total) * 100) : 0
  const vidPct  = total > 0 ? Math.round((vidDone / total) * 100) : 0

  const deriveStatus = () => {
    const s = project.status
    if (s === 'complete' || s === 'assembling' || s === 'generating_videos') return s
    if (total > 0 && vidDone === total) return 'videos_ready'
    if (total > 0 && imgDone === total) return 'images_ready'
    return s
  }
  const effectiveStatus = phase === 'idle' ? deriveStatus() : project.status

  const formatEta = (remainingScenes) => {
    if (!avgSceneMs || remainingScenes <= 0) return null
    const etaSec = Math.round((remainingScenes * avgSceneMs) / 1000)
    if (etaSec < 60) return `~${etaSec}s`
    return `~${Math.ceil(etaSec / 60)}m`
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
          <span className="project-status-badge" data-status={effectiveStatus}>
            {STATUS_LABELS[effectiveStatus] ?? effectiveStatus}
          </span>
          <button className="btn-ghost btn-danger-ghost" onClick={handleDelete}>Delete</button>
        </div>
      </header>

      <main className="project-main">

        {/* ── Step tracker ── */}
        <StepTracker status={effectiveStatus} phase={phase} />

        {/* ── Active progress banner ── */}
        {phase === 'images' && (
          <ProgressBanner
            step="Generating Images"
            detail={`Scene ${(currentIdx ?? 0) + 1} of ${total} — ${currentAction}${elapsedSeconds > 3 ? ` (${elapsedSeconds}s)` : ''}`}
            pct={imgPct}
            done={imgDone}
            total={total}
            eta={formatEta(total - imgDone)}
          />
        )}
        {phase === 'videos' && (
          <ProgressBanner
            step="Animating in Cloud"
            detail={currentAction}
            pct={vidPct}
            done={vidDone}
            total={total}
            eta={null}
          />
        )}

        {/* ── Errors ── */}
        {error && <p className="error-message project-error">{error}</p>}

        {/* ── Draft CTA ── */}
        {effectiveStatus === 'draft' && phase === 'idle' && brief && (
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

        {/* ── Resume interrupted image generation ── */}
        {effectiveStatus === 'processing' && phase === 'idle' && scenes.some(s => !s.image_url && s.status !== 'error') && (
          <div className="ready-banner">
            <div>
              <p className="ready-label">Image generation interrupted</p>
              <p className="ready-sub">{scenes.filter(s => !s.image_url).length} scene{scenes.filter(s => !s.image_url).length !== 1 ? 's' : ''} still need images.</p>
            </div>
            <button className="btn-primary" onClick={startImageGeneration}>Resume →</button>
          </div>
        )}

        {/* ── Resume video polling (fallback if auto-resume didn't trigger) ── */}
        {effectiveStatus === 'generating_videos' && phase === 'idle' && scenes.some(s => s.image_url && !s.video_url) && (
          <div className="ready-banner">
            <div>
              <p className="ready-label">Video generation in progress</p>
              <p className="ready-sub">{scenes.filter(s => s.image_url && !s.video_url).length} scene{scenes.filter(s => s.image_url && !s.video_url).length !== 1 ? 's' : ''} still animating in the cloud.</p>
            </div>
            <button className="btn-primary" onClick={startVideoGeneration}>Poll for Results →</button>
          </div>
        )}

        {/* ── Images ready ── */}
        {effectiveStatus === 'images_ready' && phase === 'idle' && (
          <div className="ready-banner">
            <div>
              <p className="ready-label">✓ All {total} images generated</p>
              <p className="ready-sub">Ready to generate video clips via Seedance 2.0 Fast. Each clip takes ~2 min.</p>
            </div>
            <button className="btn-primary" onClick={startVideoGeneration}>Animate Scenes →</button>
          </div>
        )}


        {/* ── Audio ── */}
        {['videos_ready', 'assembling'].includes(effectiveStatus) && !project.audio_url && phase === 'idle' && (
          <div className="audio-uploader-panel">
            <div className="audio-uploader-header">
              <div>
                <p className="audio-uploader-title">Narration Audio</p>
                <p className="audio-uploader-sub">Required before assembling the final video</p>
              </div>
            </div>
            <button
              className="btn-primary"
              onClick={generateAudio}
              disabled={generatingAudio}
              style={{ alignSelf: 'flex-start' }}
            >
              {generatingAudio ? '⏳ Generating with Alfred…' : '🎙️ Generate Audio with Alfred'}
            </button>
            {audioError && <p className="error-message" style={{ marginTop: '8px' }}>{audioError}</p>}
            <details style={{ marginTop: '14px' }}>
              <summary style={{ fontSize: '13px', color: 'var(--text-muted)', cursor: 'pointer', userSelect: 'none' }}>
                Or upload your own file
              </summary>
              <div style={{ marginTop: '10px' }}>
                <AudioUploader project={project} onUploaded={url => patchProject({ audio_url: url })} />
              </div>
            </details>
          </div>
        )}

        {/* ── Assembly ── */}
        {['videos_ready', 'assembling', 'complete'].includes(effectiveStatus) && phase === 'idle' && (
          vidDone < total ? (
            <div className="ready-banner" style={{ borderColor: 'var(--accent-error, #e55)' }}>
              <div>
                <p className="ready-label">⚠️ {total - vidDone} scene{total - vidDone !== 1 ? 's' : ''} still missing video</p>
                <p className="ready-sub">Retry failed scenes before assembling to avoid static images in your video.</p>
              </div>
            </div>
          ) : (
            <AssemblyPanel
              project={project}
              scenes={scenes}
              autoStart={project.status === 'assembling' && !project.video_url}
              onAssemblyStart={() => patchProject({ status: 'assembling' })}
              onComplete={url => setProject(p => ({ ...p, status: 'complete', video_url: url }))}
            />
          )
        )}

        {/* ── Scenes grid ── */}
        <div className="scenes-generation-grid">
          {scenes.map(scene => (
            <SceneCard
              key={scene.id}
              scene={scene}
              scriptExcerpt={brief?.scenes?.[scene.scene_index]?.script_excerpt}
              isActive={phase !== 'idle' && scene.scene_index === currentIdx}
              activeAction={currentAction}
              phase={phase}
              idlePhase={phase === 'idle'}
              onRetry={handleSceneRetry}
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

function StepTracker({ status, phase }) {
  const active = getActiveStep(status, phase)
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
function SceneCard({ scene, scriptExcerpt, isActive, activeAction, phase, idlePhase, onRetry }) {
  const [expanded, setExpanded] = useState(false)
  const hasVideo = !!scene.video_url
  const hasImage = !!scene.image_url
  const isError  = scene.status === 'error'
  const isImgActive = isActive && phase === 'images'
  const isVidActive = isActive && phase === 'videos'

  return (
    <>
      <div
        className={`gen-scene-card ${isActive ? 'active' : ''} ${hasVideo ? 'has-video' : hasImage ? 'done' : ''} ${isError ? 'has-error' : ''}`}
        onClick={() => setExpanded(true)}
        style={{ cursor: 'pointer' }}
      >
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
                <button className="scene-retry-btn" onClick={e => { e.stopPropagation(); onRetry(scene) }}>↺ Retry</button>
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

      {expanded && (
        <div className="scene-detail-overlay" onClick={() => setExpanded(false)}>
          <div className="scene-detail-modal" onClick={e => e.stopPropagation()}>
            <div className="scene-detail-header">
              <h3>Scene {scene.scene_index + 1}</h3>
              <button className="scene-detail-close" onClick={() => setExpanded(false)}>✕</button>
            </div>

            {hasVideo ? (
              <video src={scene.video_url} controls playsInline className="scene-detail-media" />
            ) : hasImage ? (
              <img src={scene.image_url} alt={`Scene ${scene.scene_index + 1}`} className="scene-detail-media" />
            ) : null}

            <div className="scene-detail-body">
              {scriptExcerpt && (
                <div className="scene-detail-row">
                  <span className="scene-detail-label">Narration</span>
                  <p className="scene-detail-value">{scriptExcerpt}</p>
                </div>
              )}
              {scene.image_prompt && (
                <div className="scene-detail-row">
                  <span className="scene-detail-label">Image Prompt</span>
                  <p className="scene-detail-value">{scene.image_prompt}</p>
                </div>
              )}
              {scene.motion_prompt && (
                <div className="scene-detail-row">
                  <span className="scene-detail-label">Motion Prompt</span>
                  <p className="scene-detail-value">{scene.motion_prompt}</p>
                </div>
              )}
              <div className="scene-detail-row">
                <span className="scene-detail-label">Status</span>
                <p className="scene-detail-value" style={{ textTransform: 'capitalize' }}>{scene.status || 'pending'}</p>
              </div>
            </div>

            {isError && idlePhase && (
              <button className="btn-primary" style={{ width: '100%', marginTop: '1rem' }} onClick={() => { onRetry(scene); setExpanded(false) }}>
                ↺ Retry Image Generation
              </button>
            )}
          </div>
        </div>
      )}
    </>
  )
}
