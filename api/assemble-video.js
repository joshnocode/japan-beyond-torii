import { createClient } from '@supabase/supabase-js'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { writeFile, readFile, mkdir, rm, chmod, copyFile, unlink } from 'node:fs/promises'
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

  // Guard against duplicate jobs — if already assembling, just tell the client to poll
  if (project.status === 'assembling' && !project.video_url) {
    return res.status(202).json({ status: 'assembling', alreadyRunning: true })
  }

  // Mark assembling in DB, then respond immediately so the client can disconnect.
  // Assembly continues running in the Vercel background up to maxDuration.
  // The frontend polls Supabase for completion — no need to stay on the page.
  await supabase.from('projects').update({ status: 'assembling' }).eq('id', project_id)
  res.status(202).json({ status: 'assembling' })

  // ─── Everything below runs after the client has received the response ───

  const jobDir = join(tmpdir(), `assembly_${Date.now()}`)
  await mkdir(jobDir, { recursive: true })

  try {
    const t0 = Date.now()
    const ffmpeg = await getFFmpeg()
    console.log(`[assemble] start — ${scenes.length} scenes, project ${project_id}`)

    // Download audio in background while processing video clips
    let audioExt = null
    const audioPromise = project.audio_url ? (async () => {
      const resp = await fetch(project.audio_url)
      if (!resp.ok) { console.warn('[assemble] audio download failed:', resp.status); return }
      audioExt = (project.audio_url.split('.').pop().split('?')[0] || 'mp3').toLowerCase()
      await writeFile(join(jobDir, `audio.${audioExt}`), Buffer.from(await resp.arrayBuffer()))
      console.log('[assemble] audio ready:', audioExt)
    })() : Promise.resolve()

    const BATCH_SIZE = 5
    const batches = Math.ceil(scenes.length / BATCH_SIZE)

    const downloadBatch = async (b) => {
      const start = b * BATCH_SIZE
      const end = Math.min(start + BATCH_SIZE, scenes.length)
      await Promise.all(scenes.slice(start, end).map(async (scene, bi) => {
        const idx = start + bi
        const resp = await fetch(scene.video_url)
        if (!resp.ok) throw new Error(`Scene ${scene.scene_index + 1} download failed (HTTP ${resp.status})`)
        await writeFile(join(jobDir, `orig_${idx}.mp4`), Buffer.from(await resp.arrayBuffer()))
      }))
    }

    const encodeBatch = async (b) => {
      const start = b * BATCH_SIZE
      const end = Math.min(start + BATCH_SIZE, scenes.length)
      await Promise.all(scenes.slice(start, end).map(async (_, bi) => {
        const idx = start + bi
        const src = join(jobDir, `orig_${idx}.mp4`)
        const dst = join(jobDir, `scaled_${idx}.mp4`)
        await run(ffmpeg, [
          '-loglevel', 'error', '-i', src,
          '-vf', 'scale=720:-2',
          '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '34',
          '-maxrate', '1400k', '-bufsize', '2800k', '-an',
          '-y', dst,
        ])
        await unlink(src)
      }))
      console.log(`[assemble] batch ${b + 1}/${batches} encoded (${Math.round((Date.now() - t0) / 1000)}s)`)
    }

    // Pipeline: download batch b+1 while encoding batch b
    let dlPromise = downloadBatch(0)
    for (let b = 0; b < batches; b++) {
      await dlPromise
      dlPromise = (b + 1 < batches) ? downloadBatch(b + 1) : Promise.resolve()
      await encodeBatch(b)
    }
    await dlPromise
    await audioPromise

    // Stream-copy concat (clips already encoded at identical settings — SPS/PPS match)
    const listPath = join(jobDir, 'list.txt')
    await writeFile(listPath, scenes.map((_, i) => `file '${join(jobDir, `scaled_${i}.mp4`)}'`).join('\n'))

    const outputPath = join(jobDir, 'output.mp4')
    const concatArgs = ['-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listPath]
    if (audioExt) concatArgs.push('-i', join(jobDir, `audio.${audioExt}`))
    if (audioExt) concatArgs.push('-map', '0:v:0', '-map', '1:a:0')
    concatArgs.push('-c:v', 'copy')
    if (audioExt) concatArgs.push('-c:a', 'aac', '-b:a', '128k', '-shortest')
    concatArgs.push('-y', outputPath)

    console.log('[assemble] concat + audio mux')
    await run(ffmpeg, concatArgs)
    console.log(`[assemble] encode done (${Math.round((Date.now() - t0) / 1000)}s)`)

    const outputBuf = await readFile(outputPath)
    const sizeMB = outputBuf.length / 1024 / 1024
    console.log('[assemble] output:', sizeMB.toFixed(1), 'MB — uploading')
    if (sizeMB > 45) throw new Error(`Output is ${sizeMB.toFixed(1)} MB — too large for storage (target <45 MB)`)

    const storagePath = `${project.user_id}/${project_id}/final.mp4`
    const { error: uploadErr } = await supabase.storage
      .from('project-assets')
      .upload(storagePath, outputBuf, { contentType: 'video/mp4', upsert: true })
    if (uploadErr) throw new Error(`Upload failed: ${uploadErr.message}`)

    const { data: urlData } = supabase.storage.from('project-assets').getPublicUrl(storagePath)
    const videoUrl = urlData.publicUrl

    await supabase.from('projects').update({ video_url: videoUrl, status: 'complete' }).eq('id', project_id)
    console.log(`[assemble] complete in ${Math.round((Date.now() - t0) / 1000)}s:`, videoUrl)
  } catch (err) {
    console.error('[assemble-video] FAILED:', err.message)
    await supabase.from('projects').update({ status: 'videos_ready' }).eq('id', project_id).catch(() => {})
  } finally {
    await rm(jobDir, { recursive: true, force: true }).catch(() => {})
  }
}
