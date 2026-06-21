import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'

const API_BASE = import.meta.env.DEV ? 'http://localhost:3000' : ''

const TAKAYAMA_SCRIPT = `In 1692, the most powerful government in Japanese history did something it almost never did.

It reached into a remote mountain valley — deep in the Japanese Alps — and seized direct control of a city.

Not because the city was weak.

Because it was too powerful to leave alone.

---

Takayama sits in Hida Province — one of the most geographically isolated regions in all of Japan.

For centuries, that isolation was its armor. The mountains were so severe, so unforgiving, that no army ever successfully conquered this place.

But isolation alone doesn't explain why Takayama was wealthy. The mountains did.

The forests surrounding Takayama produced some of the finest building timber in Japan. Hida carpenters — the Hida no Takumi — were so skilled they were conscripted by the imperial court to build temples, shrines, and palaces across the country. Their reputation stretched back over a thousand years.

---

When the Tokugawa Shogunate needed to rebuild Edo after the devastating Meireki Fire of 1657 — one of the deadliest fires in Japanese history — they needed timber. Enormous quantities of it.

They knew exactly where it was.

In 1692, the Shogunate abolished the local Kanamori clan's domain and declared Takayama a tenryō — territory under direct Shogunate control.

For the next 176 years, Takayama would be governed not by a local lord, but by officials appointed directly from Edo.

The Shogun owned it. Its forests, its carpenters, its wealth.

---

But here's what makes this story remarkable.

Direct Shogunate control, combined with Takayama's mountain isolation, created something almost impossible to find anywhere else in Japan.

A city that was never destroyed. Never bombed. Never modernized beyond recognition.

While Japan's great cities were flattened in World War II and rebuilt as modern metropolises, Takayama's remoteness spared it entirely.

The Edo-era merchant quarter — the sake breweries, the old government house, the timber merchant homes — survived intact.

What you walk through today is not a reconstruction. It is the original.

---

The Shogun seized Takayama because he understood something most people still don't.

The real power in feudal Japan wasn't always found in the castles or the armies.

Sometimes it was buried deep in the mountains.

In the trees.`

export default function NewProjectPage() {
  const navigate = useNavigate()
  const { session } = useAuth()
  const [title, setTitle] = useState('')
  const [script, setScript] = useState('')
  const [phase, setPhase] = useState('input') // input | analyzing | brief | saving
  const [brief, setBrief] = useState(null)
  const [error, setError] = useState('')
  const [debugInfo, setDebugInfo] = useState(null)
  const [analyzeMsg, setAnalyzeMsg] = useState('Claude is parsing your script into scenes and generating prompts…')
  const [sseLog, setSseLog] = useState([])
  const [showDebug, setShowDebug] = useState(false)

  const wordCount = script.trim().split(/\s+/).filter(Boolean).length

  const handleAnalyze = async () => {
    if (!script.trim()) return setError('Please paste your script first.')
    setError('')
    setDebugInfo(null)
    setSseLog([])
    setShowDebug(false)
    setAnalyzeMsg('Claude is parsing your script into scenes and generating prompts…')
    setPhase('analyzing')

    let httpStatus = null
    const t0 = Date.now()
    const log = []
    const addLog = (entry) => {
      const ts = `+${((Date.now() - t0) / 1000).toFixed(1)}s`
      log.push(`[${ts}] ${entry}`)
      setSseLog([...log])
    }

    try {
      addLog('Connecting to /api/analyze…')
      const res = await fetch(`${API_BASE}/api/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ script }),
      })
      httpStatus = res.status
      addLog(`HTTP ${res.status} — reading SSE stream`)

      if (!res.ok) {
        let msg = `Server error ${res.status}`
        try { const b = await res.json(); msg = b.error || b.message || msg } catch {}
        throw new Error(msg)
      }

      // Read SSE stream — server sends pings every 10s to keep iOS Safari alive,
      // then a final {type:"complete"} or {type:"error"} event.
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) { addLog('Stream closed'); break }
        buffer += decoder.decode(value, { stream: true })

        const events = buffer.split('\n\n')
        buffer = events.pop() ?? ''

        for (const event of events) {
          const dataLine = event.split('\n').find(l => l.startsWith('data: '))
          if (!dataLine) continue
          let parsed
          try { parsed = JSON.parse(dataLine.slice(6)) } catch { continue }

          if (parsed.type === 'ping') { addLog('ping ♡'); continue }
          if (parsed.type === 'progress') {
            addLog(`progress: ${parsed.message}`)
            setAnalyzeMsg(parsed.message)
            continue
          }
          if (parsed.type === 'error') {
            addLog(`error: ${parsed.message}`)
            throw new Error(parsed.message)
          }
          if (parsed.type === 'complete') {
            addLog(`complete — ${parsed.data.scene_count} scenes`)
            const data = parsed.data
            if (!title.trim() && data.title) setTitle(data.title)
            setBrief(data)
            setPhase('brief')
            return
          }
        }
      }
    } catch (err) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
      addLog(`FAILED after ${elapsed}s: ${err.message}`)
      setDebugInfo({
        timestamp: new Date().toISOString(),
        elapsed_sec: elapsed,
        http_status: httpStatus,
        error_message: err.message,
        sse_log: log,
      })
      setError(err.message)
      setPhase('input')
    }
  }

  const handleConfirm = async () => {
    setPhase('saving')
    setError('')

    try {
      const { data: project, error: insertErr } = await supabase
        .from('projects')
        .insert({
          user_id: session.user.id,
          title: title.trim() || brief.title || 'Untitled Project',
          script,
          brief,
          status: 'draft',
          cost_cents: Math.round((brief.cost_estimate?.total_usd || 0) * 100),
        })
        .select()
        .single()

      if (insertErr) throw new Error(insertErr.message)

      const scenes = brief.scenes.map((s) => ({
        project_id: project.id,
        scene_index: s.scene_number - 1,
        description: s.description,
        image_prompt: s.image_prompt,
        motion_prompt: s.motion_prompt,
        status: 'pending',
      }))

      const { error: scenesErr } = await supabase.from('scenes').insert(scenes)
      if (scenesErr) throw new Error(scenesErr.message)

      navigate(`/project/${project.id}`)
    } catch (err) {
      setError(err.message)
      setPhase('brief')
    }
  }

  const handleCancel = () => {
    setBrief(null)
    setPhase('input')
    setError('')
  }

  return (
    <div className="app-layout">
      <header className="app-header">
        <div className="header-left">
          <button className="btn-ghost" onClick={() => navigate('/dashboard')}>← Back</button>
          <span className="header-brand-mark">⛩</span>
          <span className="header-brand">New Video</span>
        </div>
      </header>

      <main className="new-project-main">
        {phase === 'analyzing' && (
          <div className="phase-overlay">
            <div className="analyzing-card">
              <div className="spinner large" />
              <h3>Analyzing Script</h3>
              <p>{analyzeMsg}</p>
              <button
                type="button"
                className="debug-copy-btn"
                style={{ marginTop: 16 }}
                onClick={() => setShowDebug(v => !v)}
              >
                {showDebug ? 'Hide log' : 'Debug log'}
              </button>
              {showDebug && (
                <div className="debug-body" style={{ marginTop: 8, width: '100%', textAlign: 'left' }}>
                  <button
                    type="button"
                    className="debug-copy-btn"
                    style={{ position: 'static', marginBottom: 6 }}
                    onClick={() => navigator.clipboard.writeText(sseLog.join('\n'))}
                  >
                    Copy log
                  </button>
                  <pre className="debug-pre">{sseLog.join('\n') || '(waiting…)'}</pre>
                </div>
              )}
            </div>
          </div>
        )}

        {phase === 'saving' && (
          <div className="phase-overlay">
            <div className="analyzing-card">
              <div className="spinner large" />
              <h3>Saving Project</h3>
              <p>Creating your project record…</p>
            </div>
          </div>
        )}

        {(phase === 'input' || phase === 'analyzing' || phase === 'saving') && (
          <div className="input-panel">
            <div className="input-panel-header">
              <h2>Script Input</h2>
              <p className="section-subtitle">Paste your narration script to generate a cinematic brief.</p>
            </div>

            <div className="input-grid">
              <div className="form-group">
                <label>Project Title <span className="label-optional">(optional — Claude will suggest one)</span></label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. The Fall of Edo Castle"
                />
              </div>

              <div className="form-group">
                <label>
                  Script
                  {wordCount > 0 && (
                    <span className="word-count">{wordCount} words · ~{Math.round(wordCount / 130)}m read</span>
                  )}
                  <button
                    type="button"
                    onClick={() => { setScript(TAKAYAMA_SCRIPT); setTitle('Takayama') }}
                    style={{ marginLeft: 'auto', fontSize: '11px', padding: '2px 8px', opacity: 0.5, background: 'transparent', border: '1px solid currentColor', borderRadius: '4px', cursor: 'pointer', color: 'inherit' }}
                  >
                    Takayama
                  </button>
                </label>
                <textarea
                  className="script-textarea"
                  value={script}
                  onChange={(e) => setScript(e.target.value)}
                  placeholder="Paste your full narration script here…"
                  rows={16}
                />
              </div>

            </div>

            {error && <p className="error-message">{error}</p>}

            {debugInfo && (
              <details className="debug-panel">
                <summary>Inspect error →</summary>
                <div className="debug-body">
                  <button
                    type="button"
                    className="debug-copy-btn"
                    onClick={() => navigator.clipboard.writeText(JSON.stringify(debugInfo, null, 2))}
                  >
                    Copy JSON
                  </button>
                  <pre className="debug-pre">{JSON.stringify(debugInfo, null, 2)}</pre>
                </div>
              </details>
            )}

            <button
              type="button"
              className="btn-primary btn-analyze"
              onClick={handleAnalyze}
              disabled={!script.trim() || phase === 'analyzing'}
            >
              Analyze Script →
            </button>
          </div>
        )}

        {phase === 'brief' && brief && (
          <div className="brief-panel">
            <div className="brief-header">
              <div>
                <h2 className="brief-title">{title || brief.title}</h2>
                <p className="brief-subtitle">Pre-Generation Brief · Review before spending</p>
              </div>
              <div className="brief-actions">
                <button type="button" className="btn-ghost" onClick={handleCancel}>Edit Script</button>
                <button type="button" className="btn-primary" onClick={handleConfirm}>
                  Confirm &amp; Generate →
                </button>
              </div>
            </div>

            {error && <p className="error-message">{error}</p>}

            <div className="brief-stats">
              <div className="stat-card">
                <span className="stat-value">{brief.scene_count}</span>
                <span className="stat-label">Scenes</span>
              </div>
              <div className="stat-card">
                <span className="stat-value">{Math.round(brief.estimated_duration_seconds / 60)}:{String(brief.estimated_duration_seconds % 60).padStart(2, '0')}</span>
                <span className="stat-label">Est. Duration</span>
              </div>
              <div className="stat-card gold">
                <span className="stat-value">${brief.cost_estimate?.total_usd?.toFixed(2)}</span>
                <span className="stat-label">Est. Cost</span>
              </div>
            </div>

            <div className="brief-section">
              <h3>Tone &amp; Style</h3>
              <p className="tone-summary">{brief.tone_summary}</p>
            </div>

            <div className="brief-section">
              <h3>Cost Breakdown</h3>
              <div className="cost-table">
                <div className="cost-row">
                  <span>Image generation ({brief.scene_count} × FLUX 1.1 Pro Ultra)</span>
                  <span>${brief.cost_estimate?.image_generation_usd?.toFixed(2)}</span>
                </div>
                <div className="cost-row">
                  <span>Video generation ({brief.scene_count} × Seedance 2.0 Fast, 5s)</span>
                  <span>${brief.cost_estimate?.video_generation_usd?.toFixed(2)}</span>
                </div>
                <div className="cost-row">
                  <span>Claude script analysis</span>
                  <span>${brief.cost_estimate?.claude_api_usd?.toFixed(2)}</span>
                </div>
                <div className="cost-row total">
                  <span>Total</span>
                  <span>${brief.cost_estimate?.total_usd?.toFixed(2)}</span>
                </div>
              </div>
            </div>

            <div className="brief-section">
              <h3>Scene Breakdown</h3>
              <div className="scenes-list">
                {brief.scenes.map((scene) => (
                  <div key={scene.scene_number} className="scene-card">
                    <div className="scene-header">
                      <span className="scene-number">Scene {scene.scene_number}</span>
                    </div>
                    <div className="scene-body">
                      <div className="scene-block">
                        <span className="scene-block-label">Script</span>
                        <p className="scene-excerpt">"{scene.script_excerpt}"</p>
                      </div>
                      <div className="scene-block">
                        <span className="scene-block-label">Visual</span>
                        <p>{scene.description}</p>
                      </div>
                      <div className="scene-block">
                        <span className="scene-block-label">Image Prompt</span>
                        <p className="scene-prompt">{scene.image_prompt}</p>
                      </div>
                      <div className="scene-block">
                        <span className="scene-block-label">Motion</span>
                        <p className="scene-prompt">{scene.motion_prompt}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="brief-footer">
              <button type="button" className="btn-ghost" onClick={handleCancel}>Edit Script</button>
              <button type="button" className="btn-primary" onClick={handleConfirm}>
                Confirm &amp; Generate →
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
