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

  const { project_id, batch_count } = req.body || {}
  if (!project_id || !batch_count) return res.status(400).json({ error: 'project_id and batch_count are required' })

  const supabase = createClient(
    process.env.VITE_SUPABASE_URL,
    process.env.VITE_SUPABASE_ANON_KEY,
    { global: { headers: { Authorization: `Bearer ${token}` } } }
  )

  const { data: project, error: projErr } = await supabase
    .from('projects').select('*').eq('id', project_id).single()
  if (projErr || !project) return res.status(404).json({ error: 'Project not found' })

  // Respond immediately — final assembly runs in background
  res.status(202).json({ status: 'finalizing' })

  const jobDir = join(tmpdir(), `final_${project_id}_${Date.now()}`)
  await mkdir(jobDir, { recursive: true })

  try {
    const t0 = Date.now()
    const ffmpeg = await getFFmpeg()
    console.log(`[final] start — stitching ${batch_count} batches`)

    // Download all batch files + audio in parallel
    const downloadTasks = Array.from({ length: batch_count }, async (_, b) => {
      const storagePath = `${project.user_id}/${project_id}/batch_${b}.mp4`
      const { data, error } = await supabase.storage
        .from('project-assets')
        .download(storagePath)
      if (error) throw new Error(`Could not download batch ${b}: ${error.message}`)
      const buf = Buffer.from(await data.arrayBuffer())
      const localPath = join(jobDir, `batch_${b}.mp4`)
      await writeFile(localPath, buf)
      return localPath
    })

    let audioLocalPath = null
    if (project.audio_url) {
      downloadTasks.push((async () => {
        const resp = await fetch(project.audio_url)
        if (!resp.ok) throw new Error(`Audio download failed (HTTP ${resp.status})`)
        const buf = Buffer.from(await resp.arrayBuffer())
        audioLocalPath = join(jobDir, 'audio')
        await writeFile(audioLocalPath, buf)
      })())
    }

    const batchFiles = await Promise.all(downloadTasks).then(results => results.slice(0, batch_count))
    console.log(`[final] downloads done (${Math.round((Date.now() - t0) / 1000)}s)`)

    // Stream-copy concat all batches (already encoded at identical settings)
    const listPath = join(jobDir, 'list.txt')
    await writeFile(listPath, batchFiles.map(p => `file '${p}'`).join('\n'))

    const outputPath = join(jobDir, 'output.mp4')
    const concatArgs = [
      '-loglevel', 'error',
      '-f', 'concat', '-safe', '0', '-i', listPath,
    ]
    if (audioLocalPath) {
      concatArgs.push('-i', audioLocalPath, '-map', '0:v:0', '-map', '1:a:0')
    }
    concatArgs.push('-c:v', 'copy')
    if (audioLocalPath) {
      concatArgs.push('-c:a', 'aac', '-b:a', '128k', '-shortest')
    }
    concatArgs.push('-y', outputPath)

    console.log('[final] stream-copy concat + audio mux')
    await run(ffmpeg, concatArgs)
    console.log(`[final] concat done (${Math.round((Date.now() - t0) / 1000)}s)`)

    const outputBuf = await readFile(outputPath)
    const sizeMB = outputBuf.length / 1024 / 1024
    console.log('[final] output:', sizeMB.toFixed(1), 'MB — uploading')
    if (sizeMB > 45) throw new Error(`Output is ${sizeMB.toFixed(1)} MB — too large for storage (target <45 MB)`)

    const finalPath = `${project.user_id}/${project_id}/final.mp4`
    const { error: uploadErr } = await supabase.storage
      .from('project-assets')
      .upload(finalPath, outputBuf, { contentType: 'video/mp4', upsert: true })
    if (uploadErr) throw new Error(`Upload failed: ${uploadErr.message}`)

    const { data: urlData } = supabase.storage.from('project-assets').getPublicUrl(finalPath)
    await supabase.from('projects')
      .update({ video_url: urlData.publicUrl, status: 'complete', assembly_error: null })
      .eq('id', project_id)

    // Clean up intermediate batch files (best-effort)
    await Promise.allSettled(
      Array.from({ length: batch_count }, (_, b) =>
        supabase.storage.from('project-assets')
          .remove([`${project.user_id}/${project_id}/batch_${b}.mp4`])
      )
    )

    console.log(`[final] complete in ${Math.round((Date.now() - t0) / 1000)}s:`, urlData.publicUrl)
  } catch (err) {
    console.error('[final] FAILED:', err.message)
    await supabase.from('projects')
      .update({ status: 'videos_ready', assembly_error: err.message })
      .eq('id', project_id)
      .catch(() => {})
  } finally {
    await rm(jobDir, { recursive: true, force: true }).catch(() => {})
  }
}
