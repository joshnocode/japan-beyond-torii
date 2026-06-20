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
  const [diagnosing, setDiagnosing] = useState(false)
  const [diagResult, setDiagResult] = useState(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)

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

  // Show error from last failed attempt — prefer DB value (real server error) over localStorage
  useEffect(() => {
    if (videoUrl) return
    const saved = localStorage.getItem(errKey(project.id))
    if (!saved) return
    // Try to get the real server error from DB; fall back to saved string
    supabase.from('projects').select('assembly_error').eq('id', project.id).single()
      .then(({ data }) => {
        setError(data?.assembly_error ? `Assembly failed: ${data.assembly_error}` : saved)
      })
      .catch(() => setError(saved))
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
  const startPolling = (startedAt, { skipRunningSet } = {}) => {
    pollStopRef.current = false
    const t = startedAt || startRef.current || Date.now()
    startRef.current = t
    if (!skipRunningSet) {
      setRunning(true)
      onAssemblyStart?.()
    }

    const poll = async () => {
      while (!pollStopRef.current) {
        await new Promise(r => setTimeout(r, 8000))
        if (pollStopRef.current) break

        const { data: proj } = await supabase
          .from('projects').select('status, video_url, assembly_error').eq('id', project.id).single()

        if (proj?.video_url) {
          pollStopRef.current = true
          handleDone(proj.video_url)
          return
        }

        // Server marked failure — status reverted to videos_ready
        if (proj?.status === 'videos_ready') {
          pollStopRef.current = true
          localStorage.removeItem(lsKey(project.id))
          const msg = proj.assembly_error
            ? `Assembly failed: ${proj.assembly_error}`
            : 'Assembly failed on the server — tap "Assemble →" to retry.'
          saveError(msg)
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
    pollStopRef.current = true

    const now = Date.now()
    localStorage.setItem(lsKey(project.id), now.toString())
    startRef.current = now
    setRunning(true)
    onAssemblyStart?.()

    try {
      const { data: { session } } = await supabase.auth.getSession()

      // Single Lambda does everything synchronously — we wait for the real result.
      // If the connection drops mid-flight, the catch block falls back to polling
      // (the Lambda still updates Supabase when it finishes).
      const res = await fetch(`${API_BASE}/api/assemble-video`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ project_id: project.id }),
      })

      let body = {}
      try { body = await res.json() } catch {}

      if (body.video_url) {
        // Success — Lambda returned the final video URL directly
        localStorage.removeItem(lsKey(project.id))
        localStorage.removeItem(errKey(project.id))
        setVideoUrl(body.video_url)
        setRunning(false)
        onComplete?.(body.video_url)
        return
      }

      if (!res.ok || body.error) {
        // Lambda returned a real error with logs we can show
        localStorage.removeItem(lsKey(project.id))
        const detail = body.log?.length
          ? `${body.error}\n\nLogs:\n${body.log.join('\n')}`
          : (body.error || `Server error ${res.status}`)
        saveError(detail)
        setRunning(false)
        return
      }

      // Unexpected response — fall back to polling
      startPolling(now, { skipRunningSet: true })
    } catch (err) {
      const msg = err.message || 'Assembly failed'
      // Network error: Lambda may still be running — poll Supabase
      if (msg === 'Load failed' || msg === 'Failed to fetch' || msg.includes('NetworkError') || msg.includes('network')) {
        startPolling(now, { skipRunningSet: true })
        return
      }
      localStorage.removeItem(lsKey(project.id))
      saveError(msg)
      setRunning(false)
    }
  }

  const runTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch(`${API_BASE}/api/test-batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ project_id: project.id }),
      })
      const json = await res.json()
      setTestResult(json)
    } catch (e) {
      setTestResult({ success: false, error: e.message, log: [] })
    } finally {
      setTesting(false)
    }
  }

  const runDiagnose = async () => {
    setDiagnosing(true)
    setDiagResult(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch(`${API_BASE}/api/diagnose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ project_id: project.id }),
      })
      const json = await res.json()
      setDiagResult(json)
    } catch (e) {
      setDiagResult({ error: e.message })
    } finally {
      setDiagnosing(false)
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

  const [downloading, setDownloading] = useState(false)

  const handleDownload = async () => {
    setDownloading(true)
    try {
      const resp = await fetch(videoUrl)
      const blob = await resp.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'japan-beyond-torii.mp4'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 5000)
    } catch {
      // Fallback: open in new tab so user can save manually
      window.open(videoUrl, '_blank')
    } finally {
      setDownloading(false)
    }
  }

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
        <button
          onClick={handleDownload}
          disabled={downloading}
          className="btn-primary btn-download"
        >
          {downloading ? 'Preparing download…' : '↓ Download MP4'}
        </button>
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
              <p className="gen-detail">Hang tight — assembling your video (~60–90s)</p>
            </div>
            <span className="assembly-eta">{fmt(remaining, elapsed, estimated)} left</span>
          </div>
          <div className="assembly-progress-bar-wrap">
            <div className="assembly-progress-bar" style={{ width: `${pct}%` }} />
          </div>
          <p className="assembly-progress-label">{elapsed}s elapsed · {pct}% estimated · build {new Date(__BUILD_TIME__).toLocaleTimeString()}</p>
        </div>
      )}

      {!running && (
        <p className="assembly-build-stamp">v {new Date(__BUILD_TIME__).toUTCString()}</p>
      )}

      {error && (
        <div className="assembly-error-box">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
            <pre className="error-message assembly-error" style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', flex: 1 }}>{error}</pre>
            <button
              className="btn-secondary"
              onClick={() => navigator.clipboard.writeText(error)}
              style={{ fontSize: '12px', padding: '4px 10px', flexShrink: 0 }}
            >
              Copy
            </button>
          </div>
        </div>
      )}

      {!running && (
        <div style={{ marginTop: '12px' }}>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button
              className="btn-secondary"
              onClick={runDiagnose}
              disabled={diagnosing || testing}
              style={{ fontSize: '13px', padding: '6px 14px' }}
            >
              {diagnosing ? 'Diagnosing…' : '🔍 Diagnose'}
            </button>
            <button
              className="btn-secondary"
              onClick={runTest}
              disabled={testing || diagnosing}
              style={{ fontSize: '13px', padding: '6px 14px' }}
            >
              {testing ? 'Testing… (~30s)' : '🧪 Test Pipeline'}
            </button>
          </div>
          {testResult && (
            <div style={{ marginTop: '10px' }}>
              <div style={{ display: 'flex', gap: '8px', marginBottom: '6px' }}>
                <span style={{ fontSize: '13px', fontWeight: 'bold', color: testResult.success ? '#4caf50' : '#f44336' }}>
                  {testResult.success ? '✅ Pipeline OK' : '❌ Pipeline FAILED'}
                </span>
                <button
                  className="btn-secondary"
                  onClick={() => navigator.clipboard.writeText(JSON.stringify(testResult, null, 2))}
                  style={{ fontSize: '13px', padding: '2px 10px' }}
                >
                  Copy
                </button>
              </div>
              <pre style={{ fontSize: '11px', background: '#111', color: '#ccc', padding: '10px', borderRadius: '6px', overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {testResult.log?.join('\n') || JSON.stringify(testResult, null, 2)}
              </pre>
            </div>
          )}
          {diagResult && (
            <div style={{ marginTop: '10px' }}>
              <button
                className="btn-secondary"
                onClick={() => navigator.clipboard.writeText(JSON.stringify(diagResult, null, 2))}
                style={{ fontSize: '13px', padding: '6px 14px', marginBottom: '6px' }}
              >
                Copy JSON
              </button>
              <pre style={{
                fontSize: '11px', background: '#111',
                color: '#ccc', padding: '10px', borderRadius: '6px',
                overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
              }}>
                {JSON.stringify(diagResult, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
