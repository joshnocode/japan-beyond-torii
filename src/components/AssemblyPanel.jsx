import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'

const API_BASE = import.meta.env.DEV ? 'http://localhost:3000' : ''
const lsKey = (id) => `jbt_assembling_${id}`
const RESUME_WINDOW_MS = 5 * 60 * 1000  // 5 min — Vercel max duration
const GIVE_UP_MS = 7 * 60 * 1000        // 7 min — bail and show retry

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

  const startRef     = useRef(null)   // ms timestamp when assembly actually began
  const pollStopRef  = useRef(false)

  const hasAudio  = !!project.audio_url
  const estimated = estimateSecs(scenes.length)
  const pct       = running ? Math.min(99, Math.round((elapsed / estimated) * 100)) : 0
  const remaining = Math.max(0, estimated - elapsed)

  // Elapsed timer — only starts startRef if not already set (preserves resume timestamp)
  useEffect(() => {
    if (!running) { setElapsed(0); startRef.current = null; return }
    if (!startRef.current) startRef.current = Date.now()
    const tid = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000))
    }, 1000)
    return () => clearInterval(tid)
  }, [running])

  useEffect(() => {
    if (project.video_url) localStorage.removeItem(lsKey(project.id))
  }, [project.id, project.video_url])

  const handleDone = (url) => {
    localStorage.removeItem(lsKey(project.id))
    setVideoUrl(url)
    onComplete?.(url)
  }

  // Poll-only resume: server is still running, just wait for it
  const resumePoll = async (startedAt) => {
    pollStopRef.current = false
    startRef.current = startedAt  // restore original start time so elapsed is correct
    setRunning(true)

    while (!pollStopRef.current) {
      await new Promise(r => setTimeout(r, 8000))
      if (pollStopRef.current) break

      const { data: proj } = await supabase
        .from('projects').select('status, video_url').eq('id', project.id).single()

      if (proj?.video_url) {
        pollStopRef.current = true
        handleDone(proj.video_url)
        setRunning(false)
        return
      }

      const age = Date.now() - startedAt
      if (age > GIVE_UP_MS) {
        localStorage.removeItem(lsKey(project.id))
        setError('Assembly timed out. Tap "Assemble →" to retry.')
        setRunning(false)
        return
      }
    }
    setRunning(false)
  }

  const startAssembly = async () => {
    if (running) return
    setError('')
    pollStopRef.current = false

    const now = Date.now()
    localStorage.setItem(lsKey(project.id), now.toString())
    startRef.current = now  // set before setRunning so timer effect doesn't overwrite

    setRunning(true)

    await supabase.from('projects').update({ status: 'assembling' }).eq('id', project.id)
    onAssemblyStart?.()

    // Parallel poll: detects completion even if the fetch connection drops on mobile
    const parallelPoll = async () => {
      while (!pollStopRef.current) {
        await new Promise(r => setTimeout(r, 10000))
        if (pollStopRef.current) break
        const { data: proj } = await supabase
          .from('projects').select('status, video_url').eq('id', project.id).single()
        if (proj?.video_url) {
          pollStopRef.current = true
          handleDone(proj.video_url)
          setRunning(false)
          return
        }
      }
    }
    parallelPoll()

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

      pollStopRef.current = true

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `Server error ${res.status}`)
      }

      const { video_url } = await res.json()
      handleDone(video_url)
      setRunning(false)
    } catch (err) {
      pollStopRef.current = true
      const msg = err.message || 'Assembly failed'

      if (msg === 'Load failed' || msg === 'Failed to fetch' || msg.includes('NetworkError')) {
        // Connection dropped — check if it actually completed
        const { data: proj } = await supabase
          .from('projects').select('status, video_url').eq('id', project.id).single()
        if (proj?.video_url) {
          handleDone(proj.video_url)
          setRunning(false)
          return
        }
        // Still assembling — switch to poll-only mode
        setError('Connection dropped — still checking for completion…')
        pollStopRef.current = false
        resumePoll(now)
        return
      }

      setError(msg)
      setRunning(false)
    }
  }

  // On mount: resume (poll-only) if server is likely still running, otherwise start fresh
  useEffect(() => {
    if (videoUrl) return
    const ts = localStorage.getItem(lsKey(project.id))
    const startedAt = ts ? parseInt(ts) : null
    const age = startedAt ? Date.now() - startedAt : Infinity

    if (startedAt && age < RESUME_WINDOW_MS) {
      // Server started < 5 min ago — don't fire a duplicate API call, just poll + restore timer
      resumePoll(startedAt)
    } else if (autoStart || (startedAt && age < GIVE_UP_MS)) {
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
