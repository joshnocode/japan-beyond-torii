import { createClient } from '@supabase/supabase-js'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { writeFile, readFile, mkdir, rm, chmod, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import ffmpegStaticPath from 'ffmpeg-static'

export const maxDuration = 300

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

  // Respond 202 immediately — assembly runs in Vercel background, client polls Supabase.
  await supabase.from('projects').update({ status: 'assembling', assembly_error: null }).eq('id', project_id)
  res.status(202).json({ status: 'assembling' })

  // ─── Everything below runs after the client has received the response ───

  const jobDir = join(tmpdir(), `assembly_${Date.now()}`)
  await mkdir(jobDir, { recursive: true })

  try {
    const t0 = Date.now()
    const ffmpeg = await getFFmpeg()
    console.log(`[assemble] start — ${scenes.length} scenes, project ${project_id}`)

    // Download in batches of 5 (parallel within each batch) and keep all clips on disk.
    // Then one single FFmpeg pass encodes everything — far fewer process startups,
    // and batch downloads are ~5x faster than sequential pipelined downloads.
    const BATCH = 5
    const batches = Math.ceil(scenes.length / BATCH)
    let totalDownloadMB = 0

    for (let b = 0; b < batches; b++) {
      const slice = scenes.slice(b * BATCH, (b + 1) * BATCH)
      const bufs = await Promise.all(slice.map(async (scene, bi) => {
        const resp = await fetch(scene.video_url)
        if (!resp.ok) throw new Error(`Scene ${scene.scene_index + 1} download failed (HTTP ${resp.status})`)
        return { idx: b * BATCH + bi, buf: Buffer.from(await resp.arrayBuffer()) }
      }))
      for (const { idx, buf } of bufs) {
        await writeFile(join(jobDir, `clip_${idx}.mp4`), buf)
        totalDownloadMB += buf.length / 1024 / 1024
      }
      console.log(`[assemble] batch ${b + 1}/${batches} downloaded — ${totalDownloadMB.toFixed(0)}MB total (${Math.round((Date.now() - t0) / 1000)}s)`)

      if (totalDownloadMB > 420) {
        throw new Error(`Downloads hit ${totalDownloadMB.toFixed(0)}MB — clips are too large for /tmp (each ~${(totalDownloadMB / scenes.length).toFixed(0)}MB). Fal.ai may be delivering very high bitrate source files.`)
      }
    }

    // Single FFmpeg pass: concat demuxer reads clips sequentially, re-encodes to 720p
    const listPath = join(jobDir, 'list.txt')
    await writeFile(listPath, scenes.map((_, i) => `file '${join(jobDir, `clip_${i}.mp4`)}'`).join('\n'))

    const outputPath = join(jobDir, 'output.mp4')
    const encodeArgs = [
      '-loglevel', 'error',
      '-f', 'concat', '-safe', '0', '-i', listPath,
    ]
    if (project.audio_url) {
      encodeArgs.push('-i', project.audio_url, '-map', '0:v:0', '-map', '1:a:0')
    }
    encodeArgs.push(
      '-vf', 'scale=720:-2',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '34',
      '-maxrate', '1400k', '-bufsize', '2800k',
    )
    if (project.audio_url) {
      encodeArgs.push('-c:a', 'aac', '-b:a', '128k', '-shortest')
    }
    encodeArgs.push('-y', outputPath)

    console.log(`[assemble] single-pass encode start (${Math.round((Date.now() - t0) / 1000)}s elapsed after downloads)`)
    await run(ffmpeg, encodeArgs)
    console.log(`[assemble] encode done (${Math.round((Date.now() - t0) / 1000)}s total)`)

    const outputBuf = await readFile(outputPath)
    const sizeMB = outputBuf.length / 1024 / 1024
    console.log('[assemble] output:', sizeMB.toFixed(1), 'MB — uploading')
    if (sizeMB > 45) throw new Error(`Output is ${sizeMB.toFixed(1)} MB — too large for storage (target <45 MB). Try generating with lower quality or fewer scenes.`)

    const storagePath = `${project.user_id}/${project_id}/final.mp4`
    const { error: uploadErr } = await supabase.storage
      .from('project-assets')
      .upload(storagePath, outputBuf, { contentType: 'video/mp4', upsert: true })
    if (uploadErr) throw new Error(`Upload failed: ${uploadErr.message}`)

    const { data: urlData } = supabase.storage.from('project-assets').getPublicUrl(storagePath)
    await supabase.from('projects').update({ video_url: urlData.publicUrl, status: 'complete' }).eq('id', project_id)
    console.log(`[assemble] complete in ${Math.round((Date.now() - t0) / 1000)}s:`, urlData.publicUrl)
  } catch (err) {
    console.error('[assemble-video] FAILED:', err.message)
    await supabase.from('projects')
      .update({ status: 'videos_ready', assembly_error: err.message })
      .eq('id', project_id)
      .catch(() => {})
  } finally {
    await rm(jobDir, { recursive: true, force: true }).catch(() => {})
  }
}
