import { createClient } from '@supabase/supabase-js'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { writeFile, readFile, mkdir, rm, chmod, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import ffmpegStaticPath from 'ffmpeg-static'

export const maxDuration = 300

// Copy ffmpeg binary to /tmp so we can chmod it — Lambda's /var/task is read-only
async function getFFmpeg() {
  const dest = join(tmpdir(), 'ffmpeg_bin')
  try {
    await copyFile(ffmpegStaticPath, dest)
    await chmod(dest, 0o755)
    return dest
  } catch {
    return ffmpegStaticPath
  }
}

function run(ffmpeg, args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpeg, args, { maxBuffer: 100 * 1024 * 1024 }, (err, _out, stderr) => {
      if (err) reject(new Error(stderr?.slice(-3000) || err.message))
      else resolve()
    })
  })
}

function srtTime(s) {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},000`
}

function buildSRT(scenes, brief) {
  return scenes.map((scene, i) => {
    const start = i * 5
    const end = (i + 1) * 5
    const raw = brief?.scenes?.[i]?.script_excerpt || scene.description || ''
    const caption = raw.length > 140 ? raw.slice(0, raw.lastIndexOf(' ', 140)) + '…' : raw
    return `${i + 1}\n${srtTime(start)} --> ${srtTime(end)}\n${caption}`
  }).join('\n\n')
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'Authorization required' })

  const { project_id } = req.body || {}
  if (!project_id) return res.status(400).json({ error: 'project_id is required' })

  const supabase = createClient(
    process.env.VITE_SUPABASE_URL,
    process.env.VITE_SUPABASE_ANON_KEY,
    { global: { headers: { Authorization: `Bearer ${token}` } } }
  )

  const [{ data: project, error: projErr }, { data: scenes }] = await Promise.all([
    supabase.from('projects').select('*').eq('id', project_id).single(),
    supabase.from('scenes').select('*').eq('project_id', project_id).order('scene_index'),
  ])

  if (projErr || !project) return res.status(404).json({ error: 'Project not found' })

  const missing = (scenes || []).filter(s => !s.video_url)
  if (missing.length) return res.status(400).json({ error: `${missing.length} scenes are missing video` })

  const jobDir = join(tmpdir(), `assembly_${Date.now()}`)
  await mkdir(jobDir, { recursive: true })

  try {
    const ffmpeg = await getFFmpeg()

    // Write concat.txt with Supabase URLs directly — FFmpeg streams them, no local downloads needed
    // This avoids downloading ~300MB of clips to /tmp before encoding
    await writeFile(
      join(jobDir, 'concat.txt'),
      scenes.map(scene => `file '${scene.video_url}'`).join('\n')
    )
    await writeFile(join(jobDir, 'subs.srt'), buildSRT(scenes, project.brief))

    // Audio only needs to be on disk (it's small)
    let audioExt = null
    if (project.audio_url) {
      const resp = await fetch(project.audio_url)
      if (resp.ok) {
        audioExt = (project.audio_url.split('.').pop().split('?')[0] || 'mp3').toLowerCase()
        await writeFile(join(jobDir, `audio.${audioExt}`), Buffer.from(await resp.arrayBuffer()))
      }
    }

    // Single-pass: concat (streaming from URLs) + scale to 720p + subtitles + encode
    // No intermediate merged.mp4 — peak /tmp usage is just output.mp4 (~40MB) + ffmpeg binary
    const srtPath = join(jobDir, 'subs.srt')
    const outputPath = join(jobDir, 'output.mp4')
    const scaleFilter = 'scale=720:-2'
    const subFilter = `${scaleFilter},subtitles=${srtPath}:force_style='FontSize=18,PrimaryColour=&HFFFFFF&,OutlineColour=&H00000000,Outline=2,BorderStyle=1,Alignment=2,MarginV=40'`

    const baseArgs = [
      '-loglevel', 'error',
      '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
      '-f', 'concat', '-safe', '0',
      '-i', join(jobDir, 'concat.txt'),
    ]

    const encodeArgs = [...baseArgs]
    if (audioExt) encodeArgs.push('-i', join(jobDir, `audio.${audioExt}`), '-map', '0:v:0', '-map', '1:a:0')
    encodeArgs.push('-vf', subFilter, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28')
    if (audioExt) encodeArgs.push('-c:a', 'aac', '-b:a', '128k', '-shortest')
    encodeArgs.push('-y', outputPath)

    try {
      await run(ffmpeg, encodeArgs)
    } catch (subErr) {
      // Fallback: encode without subtitle filter (libass may be unavailable)
      const noSubArgs = [...baseArgs]
      if (audioExt) noSubArgs.push('-i', join(jobDir, `audio.${audioExt}`), '-map', '0:v:0', '-map', '1:a:0')
      noSubArgs.push('-vf', scaleFilter, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28')
      if (audioExt) noSubArgs.push('-c:a', 'aac', '-b:a', '128k', '-shortest')
      noSubArgs.push('-y', outputPath)
      await run(ffmpeg, noSubArgs)
    }

    // Upload to Supabase
    const outputBuf = await readFile(outputPath)
    const storagePath = `${project.user_id}/${project_id}/final.mp4`
    const { error: uploadErr } = await supabase.storage
      .from('project-assets')
      .upload(storagePath, outputBuf, { contentType: 'video/mp4', upsert: true })
    if (uploadErr) throw new Error(`Upload failed: ${uploadErr.message}`)

    const { data: urlData } = supabase.storage.from('project-assets').getPublicUrl(storagePath)
    const videoUrl = urlData.publicUrl

    await supabase.from('projects').update({ video_url: videoUrl, status: 'complete' }).eq('id', project_id)

    return res.status(200).json({ video_url: videoUrl })
  } catch (err) {
    console.error('[assemble-video] error:', err.message)
    return res.status(500).json({ error: err.message || 'Assembly failed' })
  } finally {
    await rm(jobDir, { recursive: true, force: true }).catch(() => {})
  }
}
