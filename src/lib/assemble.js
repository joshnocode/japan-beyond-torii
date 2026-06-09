import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile, toBlobURL } from '@ffmpeg/util'
import { supabase } from './supabase'

const CORE_BASE = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm'

let ffmpegInstance = null

async function getFFmpeg(onLog) {
  if (ffmpegInstance) return ffmpegInstance
  const ff = new FFmpeg()
  if (onLog) ff.on('log', ({ message }) => onLog(message))
  await ff.load({
    coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
  })
  ffmpegInstance = ff
  return ff
}

function generateSRT(scenes, brief) {
  const CLIP_SECS = 5
  return scenes
    .map((scene, i) => {
      const start = i * CLIP_SECS
      const end = (i + 1) * CLIP_SECS
      const raw = brief?.scenes?.[i]?.script_excerpt || scene.description || ''
      const caption = raw.length > 140 ? raw.slice(0, raw.lastIndexOf(' ', 140)) + '…' : raw
      return `${i + 1}\n${srtTime(start)} --> ${srtTime(end)}\n${caption}`
    })
    .join('\n\n')
}

function srtTime(s) {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  return `${pad(h)}:${pad(m)}:${pad(sec)},000`
}

function pad(n) {
  return String(n).padStart(2, '0')
}

export async function assembleVideo({ project, scenes, onStage, onProgress }) {
  const report = (stage, pct = 0) => {
    onStage?.(stage)
    onProgress?.(pct)
  }

  // ── 1. Load FFmpeg WASM ────────────────────────────────────
  report('loading_ffmpeg', 0)
  const ff = await getFFmpeg()

  ff.off('progress')
  ff.on('progress', ({ progress: p }) => onProgress?.(Math.round(p * 100)))

  // ── 2. Download scene video clips ─────────────────────────
  report('downloading_clips', 0)
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i]
    onProgress?.(Math.round((i / scenes.length) * 80))
    const data = await fetchFile(scene.video_url)
    await ff.writeFile(`scene_${i}.mp4`, data)
  }
  onProgress?.(100)

  // ── 3. Download audio ──────────────────────────────────────
  let audioExt = null
  if (project.audio_url) {
    report('downloading_audio', 0)
    const audioData = await fetchFile(project.audio_url)
    audioExt = (project.audio_url.split('.').pop().split('?')[0] || 'mp3').toLowerCase()
    await ff.writeFile(`audio.${audioExt}`, audioData)
    onProgress?.(100)
  }

  // ── 4. Write concat list + SRT ────────────────────────────
  const concatContent = scenes.map((_, i) => `file 'scene_${i}.mp4'`).join('\n')
  await ff.writeFile('concat.txt', new TextEncoder().encode(concatContent))

  const srt = generateSRT(scenes, project.brief)
  await ff.writeFile('subs.srt', new TextEncoder().encode(srt))

  // ── 5. Concatenate clips (stream copy, no re-encode) ──────
  report('concatenating', 0)
  await ff.exec([
    '-f', 'concat', '-safe', '0', '-i', 'concat.txt',
    '-c', 'copy',
    'merged.mp4',
  ])
  onProgress?.(100)

  // ── 6. Final encode: audio + burned captions ──────────────
  report('encoding', 0)

  const subtitleFilter =
    "subtitles=subs.srt:force_style='FontSize=22,PrimaryColour=&HFFFFFF&,OutlineColour=&H00000000,Outline=2,BorderStyle=1,Alignment=2,MarginV=50'"

  const cmd = ['-i', 'merged.mp4']
  if (audioExt) cmd.push('-i', `audio.${audioExt}`)
  if (audioExt) cmd.push('-map', '0:v:0', '-map', '1:a:0')
  cmd.push('-vf', subtitleFilter)
  cmd.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '22')
  if (audioExt) cmd.push('-c:a', 'aac', '-b:a', '192k', '-shortest')
  cmd.push('output.mp4')

  let encodeOk = true
  try {
    await ff.exec(cmd)
  } catch {
    // Subtitle filter failed — retry without captions
    encodeOk = false
  }

  if (!encodeOk) {
    const cmdNoSubs = ['-i', 'merged.mp4']
    if (audioExt) cmdNoSubs.push('-i', `audio.${audioExt}`)
    if (audioExt) cmdNoSubs.push('-map', '0:v:0', '-map', '1:a:0')
    cmdNoSubs.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '22')
    if (audioExt) cmdNoSubs.push('-c:a', 'aac', '-b:a', '192k', '-shortest')
    cmdNoSubs.push('output.mp4')
    await ff.exec(cmdNoSubs)
  }

  // ── 7. Read result and upload to Supabase ────────────────
  report('uploading', 0)
  const outputData = await ff.readFile('output.mp4')
  const blob = new Blob([outputData.buffer], { type: 'video/mp4' })

  const storagePath = `${project.user_id}/${project.id}/final.mp4`
  const { error: uploadErr } = await supabase.storage
    .from('project-assets')
    .upload(storagePath, blob, { contentType: 'video/mp4', upsert: true })
  if (uploadErr) throw new Error(`Storage upload failed: ${uploadErr.message}`)

  const { data: urlData } = supabase.storage
    .from('project-assets')
    .getPublicUrl(storagePath)
  const videoUrl = urlData.publicUrl

  // ── 8. Update project record ──────────────────────────────
  await supabase
    .from('projects')
    .update({ video_url: videoUrl, status: 'complete' })
    .eq('id', project.id)

  // Clean up WASM virtual filesystem
  for (let i = 0; i < scenes.length; i++) {
    try { await ff.deleteFile(`scene_${i}.mp4`) } catch {}
  }
  try { await ff.deleteFile('merged.mp4') } catch {}
  try { await ff.deleteFile('output.mp4') } catch {}
  try { await ff.deleteFile('concat.txt') } catch {}
  try { await ff.deleteFile('subs.srt') } catch {}
  if (audioExt) { try { await ff.deleteFile(`audio.${audioExt}`) } catch {} }

  report('done', 100)
  return videoUrl
}
