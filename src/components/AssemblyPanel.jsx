import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'

const API_BASE = import.meta.env.DEV ? 'http://localhost:3000' : ''
const lsKey = (id) => `jbt_assembling_${id}`

// Rough estimate: ~4s per scene (streaming + encoding at ultrafast 720p)
const estimateSecs = (sceneCount) => Math.max(90, sceneCount * 4)

function fmt(secs) {
  if (secs <= 0) return 'almost done…'
  if (secs < 60) return `~${secs}s`
  return `~${Math.ceil(secs / 60)}m`
}

export default function AssemblyPanel({ project, scenes, onComplete, onAssemblyStart, autoStart }) {
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [videoUrl, setVideoUrl] = useState(project.video_url || null)
  const [elapsed, setElapsed] = useState(0)
  const startRef = useRef(null)

  const hasAudio = !!project.audio_url
  const estimated = estimateSecs(scenes.length)
  const pct = running ? Math.min(99, Math.round((elapsed / estimated) * 100)) : 0
  const remaining = Math.max(0, estimated - elapsed)

  // Elapsed timer while running
  useEffect(() => {
    if (!running) { setElapsed(0); startRef.current = null; return }
    startRef.current = Date.now()
    const tid = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000))
    }, 1000)
    return () => clearInterval(tid)
  }, [running])

  // Clear stale localStorage marker if the project already has a video
  useEffect(() => {
    if (project.video_url) localStorage.removeItem(lsKey(project.id))
  }, [project.id, project.video_url])

  const startAssembly = async () => {
    if (running) return
    setError('')
    setRunning(true)

    // Write synchronously BEFORE any async work — survives refresh even if Supabase is slow
    localStorage.setItem(lsKey(project.id), Date.now().toString())

    await supabase.from('projects').update({ status: 'assembling' }).eq('id', project.id)
    onAssemblyStart?.()

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

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `Server error ${res.status}`)
      }

      const { video_url } = await res.json()
      localStorage.removeItem(lsKey(project.id))
      setVideoUrl(video_url)
      onComplete?.(video_url)
    } catch (err) {
      setError(err.message || 'Assembly failed')
    } finally {
      setRunning(false)
    }
  }

  // Auto-resume on mount: triggered by DB status (autoStart) OR localStorage marker
  useEffect(() => {
    if (videoUrl) return
    const ts = localStorage.getItem(lsKey(project.id))
    const recentAttempt = ts && Date.now() - parseInt(ts) < 10 * 60 * 1000
    if (autoStart || recentAttempt) startAssembly()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (videoUrl) {
    return (
      <div className="assembly-done-panel">
        <div className="assembly-done-header">
          <span className="assembly-done-icon">🎬</span>
          <div>
            <p className="assembly-done-title">Final Video Ready</p>
            <p className="assembly-done-sub">9:16 · 720p · audio + captions</p>
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
              <p className="gen-detail">Streaming · encoding · uploading</p>
            </div>
            <span className="assembly-eta">{fmt(remaining)} left</span>
          </div>
          <div className="assembly-progress-bar-wrap">
            <div className="assembly-progress-bar" style={{ width: `${pct}%` }} />
          </div>
          <p className="assembly-progress-label">{elapsed}s elapsed · {pct}% estimated</p>
        </div>
      )}

      {error && <p className="error-message assembly-error">{error}</p>}
    </div>
  )
}
