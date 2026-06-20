import { useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'

const API_BASE = import.meta.env.DEV ? 'http://localhost:3000' : ''

export default function NewProjectPage() {
  const navigate = useNavigate()
  const { session } = useAuth()
  const audioRef = useRef(null)

  const [title, setTitle] = useState('')
  const [script, setScript] = useState('')
  const [audioFile, setAudioFile] = useState(null)
  const [phase, setPhase] = useState('input') // input | analyzing | brief | saving
  const [brief, setBrief] = useState(null)
  const [error, setError] = useState('')

  const wordCount = script.trim().split(/\s+/).filter(Boolean).length

  const handleAnalyze = async () => {
    if (!script.trim()) return setError('Please paste your script first.')
    setError('')
    setPhase('analyzing')

    try {
      const res = await fetch(`${API_BASE}/api/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ script }),
      })

      if (!res.ok) {
        const { error: msg } = await res.json()
        throw new Error(msg || `Server error ${res.status}`)
      }

      const data = await res.json()
      if (!title.trim() && data.title) setTitle(data.title)
      setBrief(data)
      setPhase('brief')
    } catch (err) {
      setError(err.message)
      setPhase('input')
    }
  }

  const handleConfirm = async () => {
    setPhase('saving')
    setError('')

    try {
      let audioUrl = null

      if (audioFile) {
        const ext = audioFile.name.split('.').pop()
        const path = `${session.user.id}/${Date.now()}_audio.${ext}`
        const { error: uploadErr } = await supabase.storage
          .from('project-assets')
          .upload(path, audioFile, { upsert: false })

        if (uploadErr) throw new Error(`Audio upload failed: ${uploadErr.message}`)

        const { data: urlData } = supabase.storage
          .from('project-assets')
          .getPublicUrl(path)
        audioUrl = urlData.publicUrl
      }

      const { data: project, error: insertErr } = await supabase
        .from('projects')
        .insert({
          user_id: session.user.id,
          title: title.trim() || brief.title || 'Untitled Project',
          script,
          brief,
          status: 'draft',
          audio_url: audioUrl,
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
              <p>Claude is parsing your script into scenes and generating prompts…</p>
            </div>
          </div>
        )}

        {phase === 'saving' && (
          <div className="phase-overlay">
            <div className="analyzing-card">
              <div className="spinner large" />
              <h3>Saving Project</h3>
              <p>Uploading audio and creating project record…</p>
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
                </label>
                <textarea
                  className="script-textarea"
                  value={script}
                  onChange={(e) => setScript(e.target.value)}
                  placeholder="Paste your full narration script here…"
                  rows={16}
                />
              </div>

              <div className="form-group">
                <label>
                  ElevenLabs Audio File
                  <span className="label-optional"> (MP3, WAV, or M4A — can add after)</span>
                </label>
                <div
                  className={`audio-drop-zone ${audioFile ? 'has-file' : ''}`}
                  onClick={() => audioRef.current?.click()}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault()
                    const f = e.dataTransfer.files[0]
                    if (f) setAudioFile(f)
                  }}
                >
                  {audioFile ? (
                    <div className="audio-file-info">
                      <span className="audio-icon">🎙️</span>
                      <div>
                        <p className="audio-name">{audioFile.name}</p>
                        <p className="audio-size">{(audioFile.size / 1024 / 1024).toFixed(1)} MB</p>
                      </div>
                      <button
                        className="remove-audio"
                        onClick={(e) => { e.stopPropagation(); setAudioFile(null) }}
                      >×</button>
                    </div>
                  ) : (
                    <div className="audio-placeholder">
                      <span>🎵</span>
                      <p>Click or drag audio file here</p>
                    </div>
                  )}
                  <input
                    ref={audioRef}
                    type="file"
                    accept="audio/*"
                    style={{ display: 'none' }}
                    onChange={(e) => e.target.files[0] && setAudioFile(e.target.files[0])}
                  />
                </div>
              </div>
            </div>

            {error && <p className="error-message">{error}</p>}

            <button
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
                <button className="btn-ghost" onClick={handleCancel}>Edit Script</button>
                <button className="btn-primary" onClick={handleConfirm}>
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
              <button className="btn-ghost" onClick={handleCancel}>Edit Script</button>
              <button className="btn-primary" onClick={handleConfirm}>
                Confirm &amp; Generate →
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
