import { useState, useRef } from 'react'
import { supabase } from '../lib/supabase'

export default function AudioUploader({ project, onUploaded }) {
  const [uploading, setUploading] = useState(false)
  const [file, setFile] = useState(null)
  const [error, setError] = useState('')
  const inputRef = useRef(null)

  const handleFile = (f) => {
    if (!f) return
    setFile(f)
    setError('')
  }

  const handleUpload = async () => {
    if (!file) return
    setUploading(true)
    setError('')
    try {
      const ext = file.name.split('.').pop()
      const path = `${project.user_id}/${project.id}/audio.${ext}`
      const { error: uploadErr } = await supabase.storage
        .from('project-assets')
        .upload(path, file, { upsert: true })
      if (uploadErr) throw new Error(uploadErr.message)

      const { data: urlData } = supabase.storage.from('project-assets').getPublicUrl(path)
      const audioUrl = urlData.publicUrl

      await supabase.from('projects').update({ audio_url: audioUrl }).eq('id', project.id)
      onUploaded?.(audioUrl)
    } catch (err) {
      setError(err.message)
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="audio-uploader-panel">
      <div className="audio-uploader-header">
        <div>
          <p className="audio-uploader-title">Upload ElevenLabs Audio</p>
          <p className="audio-uploader-sub">Required before assembling the final video</p>
        </div>
      </div>

      <div
        className={`audio-drop-zone ${file ? 'has-file' : ''}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); handleFile(e.dataTransfer.files[0]) }}
      >
        {file ? (
          <div className="audio-file-info">
            <span className="audio-icon">🎙️</span>
            <div>
              <p className="audio-name">{file.name}</p>
              <p className="audio-size">{(file.size / 1024 / 1024).toFixed(1)} MB</p>
            </div>
            <button
              className="remove-audio"
              onClick={(e) => { e.stopPropagation(); setFile(null) }}
            >×</button>
          </div>
        ) : (
          <div className="audio-placeholder">
            <span>🎵</span>
            <p>Click or drag MP3, WAV, or M4A here</p>
          </div>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="audio/*"
          style={{ display: 'none' }}
          onChange={(e) => handleFile(e.target.files[0])}
        />
      </div>

      {error && <p className="error-message">{error}</p>}

      <button
        className="btn-primary"
        onClick={handleUpload}
        disabled={!file || uploading}
        style={{ alignSelf: 'flex-end' }}
      >
        {uploading ? 'Uploading…' : 'Save Audio'}
      </button>
    </div>
  )
}
