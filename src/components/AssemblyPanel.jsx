import { useState } from 'react'
import { assembleVideo } from '../lib/assemble'

const STAGES = {
  loading_ffmpeg: { label: 'Loading FFmpeg', detail: 'Downloading ~30 MB video engine (cached after first use)…' },
  downloading_clips: { label: 'Downloading Clips', detail: 'Fetching scene videos from Fal.ai…' },
  downloading_audio: { label: 'Downloading Audio', detail: 'Fetching ElevenLabs audio from Supabase…' },
  concatenating: { label: 'Concatenating', detail: 'Joining scene clips in order…' },
  encoding: { label: 'Encoding', detail: 'Burning captions, mixing audio, exporting MP4…' },
  uploading: { label: 'Uploading', detail: 'Saving final video to Supabase storage…' },
  done: { label: 'Complete', detail: 'Your video is ready.' },
  error: { label: 'Failed', detail: '' },
}

export default function AssemblyPanel({ project, scenes, onComplete }) {
  const [stage, setStage] = useState(null)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState('')
  const [videoUrl, setVideoUrl] = useState(project.video_url || null)

  const hasAudio = !!project.audio_url
  const isRunning = stage && stage !== 'done' && stage !== 'error'

  const startAssembly = async () => {
    setError('')
    setStage('loading_ffmpeg')
    setProgress(0)
    try {
      const url = await assembleVideo({
        project,
        scenes,
        onStage: setStage,
        onProgress: setProgress,
      })
      setVideoUrl(url)
      onComplete?.(url)
    } catch (err) {
      setError(err.message || 'Assembly failed')
      setStage('error')
    }
  }

  // Already complete
  if (videoUrl && stage !== 'error') {
    return (
      <div className="assembly-done-panel">
        <div className="assembly-done-header">
          <span className="assembly-done-icon">🎬</span>
          <div>
            <p className="assembly-done-title">Final Video Ready</p>
            <p className="assembly-done-sub">9:16 MP4 · audio + captions</p>
          </div>
        </div>
        <video
          src={videoUrl}
          controls
          playsInline
          className="final-video-preview"
        />
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
        {!isRunning && !videoUrl && (
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

      {!hasAudio && !isRunning && (
        <p className="assembly-warning">
          ⚠️ No audio file found for this project. Go back to the script page to upload your ElevenLabs audio before assembling.
        </p>
      )}

      {isRunning && (
        <div className="assembly-progress">
          <div className="assembly-stages">
            {Object.entries(STAGES).slice(0, -2).map(([key, info]) => {
              const stageKeys = Object.keys(STAGES).slice(0, -2)
              const currentIdx = stageKeys.indexOf(stage)
              const thisIdx = stageKeys.indexOf(key)
              const isDone = thisIdx < currentIdx
              const isActive = key === stage
              return (
                <div
                  key={key}
                  className={`assembly-stage-step ${isActive ? 'active' : ''} ${isDone ? 'done' : ''}`}
                >
                  <span className="step-dot">{isDone ? '✓' : isActive ? '◉' : '○'}</span>
                  <span className="step-label">{info.label}</span>
                </div>
              )
            })}
          </div>

          <div className="assembly-active-detail">
            <p className="assembly-active-label">{STAGES[stage]?.label}</p>
            <p className="assembly-active-sub">{STAGES[stage]?.detail}</p>
            {(stage === 'encoding' || stage === 'downloading_clips') && progress > 0 && (
              <div className="assembly-bar-wrap">
                <div className="assembly-bar" style={{ width: `${progress}%` }} />
                <span className="assembly-pct">{progress}%</span>
              </div>
            )}
            {(stage === 'loading_ffmpeg' || stage === 'concatenating' || stage === 'uploading' || stage === 'downloading_audio') && (
              <div className="assembly-spinner-row">
                <div className="spinner" />
              </div>
            )}
          </div>
        </div>
      )}

      {error && <p className="error-message assembly-error">{error}</p>}
    </div>
  )
}
