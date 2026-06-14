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

async function fetchClip(url, idx) {
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`Scene ${idx + 1} download failed (HTTP ${resp.status})`)
  return Buffer.from(await resp.arrayBuffer())
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

    // Pipelined sequential: download clip N+1 while ffmpeg encodes clip N.
    // One ffmpeg at a time → no CPU contention. Peak disk: 1 original + growing scaled set.
    let nextFetch = fetchClip(scenes[0].video_url, 0)

    for (let i = 0; i < scenes.length; i++) {
      const clipBuf = await nextFetch
      // Kick off next download immediately so it runs in parallel with encode
      nextFetch = i + 1 < scenes.length
        ? fetchClip(scenes[i + 1].video_url, i + 1)
        : Promise.resolve(null)

      const origPath = join(jobDir, `orig_${i}.mp4`)
      const scaledPath = join(jobDir, `scaled_${i}.mp4`)

      await writeFile(origPath, clipBuf)
      await run(ffmpeg, [
        '-loglevel', 'error', '-i', origPath,
        '-vf', 'scale=720:-2',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '34',
        '-maxrate', '1400k', '-bufsize', '2800k', '-an',
        '-y', scaledPath,
      ])
      await unlink(origPath)

      if ((i + 1) % 5 === 0 || i === scenes.length - 1)
        console.log(`[assemble] ${i + 1}/${scenes.length} clips done (${Math.round((Date.now() - t0) / 1000)}s)`)
    }

    // Stream-copy concat + audio mux
    const listPath = join(jobDir, 'list.txt')
    await writeFile(listPath, scenes.map((_, i) => `file '${join(jobDir, `scaled_${i}.mp4`)}'`).join('\n'))

    const outputPath = join(jobDir, 'output.mp4')
    const concatArgs = [
      '-loglevel', 'error',
      '-f', 'concat', '-safe', '0', '-i', listPath,
    ]
    if (project.audio_url) {
      concatArgs.push('-i', project.audio_url, '-map', '0:v:0', '-map', '1:a:0')
    }
    concatArgs.push('-c:v', 'copy')
    if (project.audio_url) {
      concatArgs.push('-c:a', 'aac', '-b:a', '128k', '-shortest')
    }
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
