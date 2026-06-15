import { createClient } from '@supabase/supabase-js'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { writeFile, mkdir, rm, chmod, copyFile, unlink } from 'node:fs/promises'
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

  const { project_id, batch_index, scene_ids } = req.body || {}
  if (project_id == null || batch_index == null || !scene_ids?.length) {
    return res.status(400).json({ error: 'project_id, batch_index, and scene_ids are required' })
  }

  const supabase = createClient(
    process.env.VITE_SUPABASE_URL,
    process.env.VITE_SUPABASE_ANON_KEY,
    { global: { headers: { Authorization: `Bearer ${token}` } } }
  )

  const { data: project, error: projErr } = await supabase
    .from('projects').select('user_id').eq('id', project_id).single()
  if (projErr || !project) return res.status(404).json({ error: 'Project not found' })

  // Respond immediately — batch runs in background
  res.status(202).json({ status: 'processing', batch_index })

  const jobDir = join(tmpdir(), `batch_${project_id}_${batch_index}_${Date.now()}`)
  await mkdir(jobDir, { recursive: true })

  try {
    const t0 = Date.now()
    const ffmpeg = await getFFmpeg()
    console.log(`[batch-${batch_index}] start — ${scene_ids.length} clips`)

    // Download all clips in this batch in parallel
    const clips = await Promise.all(scene_ids.map(async ({ video_url, scene_index }) => {
      const resp = await fetch(video_url)
      if (!resp.ok) throw new Error(`Scene ${scene_index + 1} download failed (HTTP ${resp.status})`)
      return { scene_index, buf: Buffer.from(await resp.arrayBuffer()) }
    }))
    console.log(`[batch-${batch_index}] downloads done (${Math.round((Date.now() - t0) / 1000)}s)`)

    // Encode each clip sequentially (one ffmpeg at a time = full CPU)
    const scaledPaths = []
    for (const { scene_index, buf } of clips) {
      const origPath = join(jobDir, `orig_${scene_index}.mp4`)
      const scaledPath = join(jobDir, `scaled_${scene_index}.mp4`)
      await writeFile(origPath, buf)
      await run(ffmpeg, [
        '-loglevel', 'error', '-i', origPath,
        '-vf', 'scale=720:-2',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '34',
        '-maxrate', '1400k', '-bufsize', '2800k', '-an',
        '-y', scaledPath,
      ])
      await unlink(origPath)
      scaledPaths.push({ scene_index, path: scaledPath })
    }
    console.log(`[batch-${batch_index}] encode done (${Math.round((Date.now() - t0) / 1000)}s)`)

    // Concat this batch's clips into one intermediate MP4 (stream-copy, same settings)
    const listPath = join(jobDir, 'list.txt')
    // Sort by scene_index to ensure correct order
    scaledPaths.sort((a, b) => a.scene_index - b.scene_index)
    await writeFile(listPath, scaledPaths.map(({ path }) => `file '${path}'`).join('\n'))

    const batchOutput = join(jobDir, 'batch.mp4')
    await run(ffmpeg, [
      '-loglevel', 'error',
      '-f', 'concat', '-safe', '0', '-i', listPath,
      '-c:v', 'copy', '-an',
      '-y', batchOutput,
    ])

    // Upload intermediate file to Supabase Storage
    const { readFile } = await import('node:fs/promises')
    const batchBuf = await readFile(batchOutput)
    const storagePath = `${project.user_id}/${project_id}/batch_${batch_index}.mp4`
    const { error: uploadErr } = await supabase.storage
      .from('project-assets')
      .upload(storagePath, batchBuf, { contentType: 'video/mp4', upsert: true })
    if (uploadErr) throw new Error(`Batch ${batch_index} upload failed: ${uploadErr.message}`)

    console.log(`[batch-${batch_index}] uploaded ${(batchBuf.length / 1024 / 1024).toFixed(1)}MB (${Math.round((Date.now() - t0) / 1000)}s)`)
  } catch (err) {
    console.error(`[batch-${batch_index}] FAILED:`, err.message)
    // Signal failure by writing an error marker to storage
    const supabaseAdmin = createClient(
      process.env.VITE_SUPABASE_URL,
      process.env.VITE_SUPABASE_ANON_KEY,
      { global: { headers: { Authorization: `Bearer ${token}` } } }
    )
    const errPath = `${project.user_id}/${project_id}/batch_${batch_index}.error`
    await supabaseAdmin.storage
      .from('project-assets')
      .upload(errPath, Buffer.from(err.message), { contentType: 'text/plain', upsert: true })
      .catch(() => {})
    // Also propagate error up to project level
    await supabaseAdmin.from('projects')
      .update({ status: 'videos_ready', assembly_error: `Batch ${batch_index} failed: ${err.message}` })
      .eq('id', project_id)
      .catch(() => {})
  } finally {
    await rm(jobDir, { recursive: true, force: true }).catch(() => {})
  }
}
