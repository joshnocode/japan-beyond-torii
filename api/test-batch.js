import { createClient } from '@supabase/supabase-js'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { writeFile, mkdir, rm, chmod, copyFile, readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import ffmpegStaticPath from 'ffmpeg-static'

export const maxDuration = 120

async function getFFmpeg() {
  const dest = join(tmpdir(), 'ffmpeg_test_bin')
  try { await copyFile(ffmpegStaticPath, dest); await chmod(dest, 0o755); return dest }
  catch { return ffmpegStaticPath }
}

function run(ffmpeg, args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpeg, args, { maxBuffer: 100 * 1024 * 1024 }, (err, _out, stderr) => {
      if (err) reject(new Error(stderr?.slice(-2000) || err.message))
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
  if (!project_id) return res.status(400).json({ error: 'project_id required' })

  const supabase = createClient(
    process.env.VITE_SUPABASE_URL,
    process.env.VITE_SUPABASE_ANON_KEY,
    { global: { headers: { Authorization: `Bearer ${token}` } } }
  )

  const log = []
  const t0 = Date.now()
  const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`

  const { data: project } = await supabase.from('projects').select('user_id').eq('id', project_id).single()
  if (!project) return res.status(404).json({ error: 'Project not found' })

  const { data: scenes } = await supabase.from('scenes')
    .select('scene_index,video_url').eq('project_id', project_id)
    .order('scene_index').limit(3) // test with first 3 clips only

  const jobDir = join(tmpdir(), `test_${project_id}_${Date.now()}`)
  await mkdir(jobDir, { recursive: true })

  try {
    // Step 1: ffmpeg binary
    log.push(`[${ts()}] getting ffmpeg binary`)
    const ffmpeg = await getFFmpeg()
    log.push(`[${ts()}] ffmpeg path: ${ffmpeg}`)

    // Step 2: verify ffmpeg works
    await run(ffmpeg, ['-version']).catch(e => { throw new Error(`ffmpeg -version failed: ${e.message}`) })
    log.push(`[${ts()}] ffmpeg -version OK`)

    // Step 3: download first 3 clips
    log.push(`[${ts()}] downloading ${scenes.length} clips`)
    const clips = await Promise.all(scenes.map(async (s) => {
      const resp = await fetch(s.video_url)
      if (!resp.ok) throw new Error(`Scene ${s.scene_index + 1} HTTP ${resp.status}`)
      const buf = Buffer.from(await resp.arrayBuffer())
      log.push(`[${ts()}] scene ${s.scene_index + 1}: ${(buf.length / 1024 / 1024).toFixed(1)}MB downloaded`)
      return { scene_index: s.scene_index, buf }
    }))

    // Step 4: encode each clip
    log.push(`[${ts()}] encoding clips`)
    const scaledPaths = []
    for (const { scene_index, buf } of clips) {
      const origPath = join(jobDir, `orig_${scene_index}.mp4`)
      const scaledPath = join(jobDir, `scaled_${scene_index}.mp4`)
      await writeFile(origPath, buf)
      await run(ffmpeg, [
        '-loglevel', 'error', '-i', origPath,
        '-vf', 'scale=720:-2', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '34',
        '-maxrate', '1400k', '-bufsize', '2800k', '-an', '-y', scaledPath,
      ])
      await unlink(origPath)
      const stat = await readFile(scaledPath)
      log.push(`[${ts()}] scene ${scene_index + 1} encoded: ${(stat.length / 1024 / 1024).toFixed(1)}MB`)
      scaledPaths.push({ scene_index, path: scaledPath })
    }

    // Step 5: concat
    log.push(`[${ts()}] concatenating`)
    scaledPaths.sort((a, b) => a.scene_index - b.scene_index)
    const listPath = join(jobDir, 'list.txt')
    await writeFile(listPath, scaledPaths.map(({ path }) => `file '${path}'`).join('\n'))
    const batchOut = join(jobDir, 'batch.mp4')
    await run(ffmpeg, [
      '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listPath,
      '-c:v', 'copy', '-an', '-y', batchOut,
    ])
    const batchBuf = await readFile(batchOut)
    log.push(`[${ts()}] concat done: ${(batchBuf.length / 1024 / 1024).toFixed(1)}MB`)

    // Step 6: upload to storage
    log.push(`[${ts()}] uploading to storage`)
    const testPath = `${project.user_id}/${project_id}/test_batch.mp4`
    const { error: uploadErr } = await supabase.storage
      .from('project-assets')
      .upload(testPath, batchBuf, { contentType: 'video/mp4', upsert: true })
    if (uploadErr) throw new Error(`Upload failed: ${uploadErr.message}`)
    log.push(`[${ts()}] upload OK`)

    // Cleanup test file
    await supabase.storage.from('project-assets').remove([testPath]).catch(() => {})

    return res.status(200).json({ success: true, total_sec: ((Date.now() - t0) / 1000).toFixed(1), log })
  } catch (err) {
    log.push(`[${ts()}] FAILED: ${err.message}`)
    return res.status(200).json({ success: false, error: err.message, log })
  } finally {
    await rm(jobDir, { recursive: true, force: true }).catch(() => {})
  }
}
