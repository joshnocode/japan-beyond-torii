import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'

const API_BASE = import.meta.env.DEV ? 'http://localhost:3000' : ''
const lsKey = (id) => `jbt_assembling_${id}`
const errKey = (id) => `jbt_last_err_${id}`
const GIVE_UP_MS = 10 * 60 * 1000

// Batched encode: ~8s per batch of 5 clips + 10s overhead
const estimateSecs = (sceneCount) => Math.max(60, Math.ceil(sceneCount / 5) * 8 + 10)

function fmt(remaining, elapsed, estimated) {
  if (elapsed > estimated * 1.2) return 'still working…'
  if (remaining <= 0) return 'almost done…'
  if (remaining < 60) return `~${remaining}s`
  return `~${Math.ceil(remaining / 60)}m`
}

export default function AssemblyPanel({ project, scenes, onComplete, onAssemblyStart, autoStart }) {
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [videoUrl, setVideoUrl] = useState(project.video_url || null)
  const [elapsed, setElapsed] = useState(0)

  const startRef    = useRef(null)
  const pollStopRef = useRef(false)

  const hasAudio  = !!project.audio_url
  const estimated = estimateSecs(scenes.length)
  const pct       = running ? Math.min(99, Math.round((elapsed / estimated) * 100)) : 0
  const remaining = Math.max(0, estimated - elapsed)

  useEffect(() => {
    if (!running) { setElapsed(0); startRef.current = null; return }
    if (!startRef.current) startRef.current = Date.now()
    const tid = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000))
    }, 1000)
    return () => clearInterval(tid)
  }, [running])

  useEffect(() => {
    if (project.video_url) {
      localStorage.removeItem(lsKey(project.id))
      localStorage.removeItem(errKey(project.id))
    }
  }, [project.id, project.video_url])

  // Show persisted error from last failed attempt (survives page reload)
  useEffect(() => {
    const saved = localStorage.getItem(errKey(project.id))
    if (saved && !videoUrl) setError(saved)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const saveError = (msg) => {
    localStorage.setItem(errKey(project.id), msg)
    setError(msg)
  }

  const clearError = () => {
    localStorage.removeItem(errKey(project.id))
    setError('')
  }

  const handleDone = (url) => {
    localStorage.removeItem(lsKey(project.id))
    localStorage.removeItem(errKey(project.id))
    setVideoUrl(url)
    setRunning(false)
    onComplete?.(url)
  }

  // Pure polling — assembly runs in cloud, we just watch DB
  const startPolling = (startedAt) => {
    pollStopRef.current = false
    const t = startedAt || startRef.current || Date.now()
    startRef.current = t
    setRunning(true)
    onAssemblyStart?.()

    const poll = async () => {
      while (!pollStopRef.current) {
        await new Promise(r => setTimeout(r, 8000))
        if (pollStopRef.current) break

        const { data: proj } = await supabase
          .from('projects').select('status, video_url').eq('id', project.id).single()

        if (proj?.video_url) {
          pollStopRef.current = true
          handleDone(proj.video_url)
          return
        }

        // Server marked failure — status reverted to videos_ready
        if (proj?.status === 'videos_ready') {
          pollStopRef.current = true
          localStorage.removeItem(lsKey(project.id))
          saveError('Assembly failed on the server — tap "Assemble →" to retry.')
          setRunning(false)
          return
        }

        const age = Date.now() - t
        if (age > GIVE_UP_MS) {
          pollStopRef.current = true
          localStorage.removeItem(lsKey(project.id))
          saveError('Assembly timed out — server took too long. Tap "Assemble →" to retry.')
          setRunning(false)
          return
        }
      }
      setRunning(false)
    }

    poll()
  }

  const startAssembly = async () => {
    if (running) return
    clearError()
    pollStopRef.current = true // stop any existing poll

    const now = Date.now()
    localStorage.setItem(lsKey(project.id), now.toString())
    startRef.current = now

    // Reset any stuck 'assembling' state (e.g. Lambda was hard-killed, catch never ran)
    await supabase.from('projects').update({ status: 'videos_ready' }).eq('id', project.id).catch(() => {})

    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch(`${API_BASE}/api/assemble-video`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ project_id: project.id }),
      })

      if (res.status === 202) {
        // Assembly kicked off in cloud — switch to poll mode
        onAssemblyStart?.()
        startPolling(now)
        return
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `Server error ${res.status}`)
      }

      // Shouldn't normally reach here, but handle gracefully
      startPolling(now)
    } catch (err) {
      const msg = err.message || 'Assembly failed'
      // Network error: server may still be running — poll to find out
      if (msg === 'Load failed' || msg === 'Failed to fetch' || msg.includes('NetworkError')) {
        onAssemblyStart?.()
        startPolling(now)
        return
      }
      // Hard client-side error (e.g. auth failure)
      localStorage.removeItem(lsKey(project.id))
      saveError(msg)
    }
  }

  // On mount: resume polling if assembly was in-flight (works across page reloads / app closes)
  useEffect(() => {
    if (videoUrl) return

    const ts = localStorage.getItem(lsKey(project.id))
    const startedAt = ts ? parseInt(ts) : null
    const age = startedAt ? Date.now() - startedAt : Infinity

    // DB says assembling — always resume poll regardless of localStorage age
    if (project.status === 'assembling' && !project.video_url) {
      startPolling(startedAt || Date.now())
      return
    }

    if (startedAt && age < GIVE_UP_MS) {
      startPolling(startedAt)
      return
    }

    if (autoStart) {
      startAssembly()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (videoUrl) {
    return (
      <div className="assembly-done-panel">
        <div className="assembly-done-header">
          <span className="assembly-done-icon">🎬</span>
          <div>
            <p className="assembly-done-title">Final Video Ready</p>
            <p className="assembly-done-sub">9:16 · 720p · audio</p>
          </div>
        </div>
        <video src={videoUrl} controls playsInline className="final-video-preview" />
        <a
          href={videoUrl}
          download="japan-beyond-torii.mp4"
          target="_blank"
          rel="noreferrer"
          className="btn-primary btn-download"
        >
          ↓ Download MP4
        </a>
      </div>
    )
  }

  return (
    <div className="assembly-panel">
      <div className="assembly-panel-header">
        <div>
          <h3>Assemble Final Video</h3>
          <p className="assembly-sub">
            {scenes.length} clips · {scenes.length * 5}s ·{' '}
            {hasAudio ? '🎙️ Audio ready' : '⚠️ No audio uploaded'}
          </p>
        </div>
        {!running && (
          <button
            className="btn-primary"
            onClick={startAssembly}
            disabled={!hasAudio}
            title={!hasAudio ? 'Upload your ElevenLabs audio file first' : undefined}
          >
            Assemble →
          </button>
        )}
      </div>

      {!hasAudio && !running && (
        <p className="assembly-warning">
          ⚠️ No audio file found. Upload your ElevenLabs audio before assembling.
        </p>
      )}

      {running && (
        <div className="assembly-cloud-progress">
          <div className="assembly-progress-top">
            <div className="spinner" />
            <div style={{ flex: 1 }}>
              <p className="gen-step">Assembling in Cloud</p>
              <p className="gen-detail">You can close this page — we'll finish in the background</p>
            </div>
            <span className="assembly-eta">{fmt(remaining, elapsed, estimated)} left</span>
          </div>
          <div className="assembly-progress-bar-wrap">
            <div className="assembly-progress-bar" style={{ width: `${pct}%` }} />
          </div>
          <p className="assembly-progress-label">{elapsed}s elapsed · {pct}% estimated</p>
        </div>
      )}

      {error && (
        <div className="assembly-error-box">
          <p className="error-message assembly-error">{error}</p>
          <p className="assembly-error-hint">Screenshot this error and share it to help debug.</p>
        </div>
      )}
    </div>
  )
}
