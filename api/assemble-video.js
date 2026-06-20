import { createClient } from '@supabase/supabase-js'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { writeFile, readFile, mkdir, rm, chmod, copyFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import ffmpegStaticPath from 'ffmpeg-static'

export const maxDuration = 300

async function getFFmpeg() {
  const dest = join(tmpdir(), 'ffmpeg_bin')
  try { await copyFile(ffmpegStaticPath, dest); await chmod(dest, 0o755); return dest }
  catch { return ffmpegStaticPath }
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
    supabase.from('scenes').select('scene_index,video_url').eq('project_id', project_id).order('scene_index'),
  ])

  if (projErr || !project) return res.status(404).json({ error: 'Project not found' })

  const missing = (scenes || []).filter(s => !s.video_url)
  if (missing.length) return res.status(400).json({ error: `${missing.length} scenes are missing video` })

  await supabase.from('projects')
    .update({ status: 'assembling', assembly_error: null })
    .eq('id', project_id)

  const jobDir = join(tmpdir(), `asm_${project_id}_${Date.now()}`)
  await mkdir(jobDir, { recursive: true })

  const log = []
  const t0 = Date.now()
  const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`

  try {
    const ffmpeg = await getFFmpeg()
    log.push(`[${ts()}] ffmpeg ready`)

    // Download clips and audio in parallel
    log.push(`[${ts()}] downloading ${scenes.length} clips + audio`)
    const [clips, audioBuf] = await Promise.all([
      Promise.all(scenes.map(async (s) => {
        const resp = await fetch(s.video_url)
        if (!resp.ok) throw new Error(`Scene ${s.scene_index + 1} download failed (HTTP ${resp.status})`)
        const buf = Buffer.from(await resp.arrayBuffer())
        return { scene_index: s.scene_index, buf }
      })),
      project.audio_url
        ? fetch(project.audio_url).then(r => {
            if (!r.ok) throw new Error(`Audio download failed (HTTP ${r.status})`)
            return r.arrayBuffer().then(ab => Buffer.from(ab))
          })
        : Promise.resolve(null),
    ])
    log.push(`[${ts()}] downloads complete`)

    // Write audio and probe its duration so we can loop clips to fill the narration
    let audioPath = null
    let audioDuration = null
    if (audioBuf) {
      audioPath = join(jobDir, 'audio.mp3')
      await writeFile(audioPath, audioBuf)
      log.push(`[${ts()}] audio: ${(audioBuf.length / 1024 / 1024).toFixed(1)}MB`)

      // Probe duration — ffmpeg -i with no output always prints file info to stderr
      const probeOut = await new Promise((resolve) => {
        execFile(ffmpeg, ['-i', audioPath],
          { maxBuffer: 10 * 1024 * 1024 },
          (_err, _out, stderr) => resolve(stderr || ''))
      })
      const m = probeOut.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/)
      if (m) {
        audioDuration = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3])
        log.push(`[${ts()}] audio duration (probed): ${audioDuration.toFixed(1)}s`)
      } else {
        // Fallback: use the estimated duration stored in the brief
        audioDuration = project.brief?.estimated_duration_seconds || null
        log.push(audioDuration
          ? `[${ts()}] audio duration (from brief): ${audioDuration}s`
          : `[${ts()}] WARNING: could not detect audio duration — clips will not be looped`)
        log.push(`[${ts()}] probe output: ${probeOut.slice(0, 500)}`)
      }
    }

    // Each clip is looped to fill its equal share of the narration.
    // Without audio, clips play at their native 5s length.
    const clipDuration = audioDuration ? audioDuration / scenes.length : null
    if (clipDuration) log.push(`[${ts()}] looping each clip to ${clipDuration.toFixed(2)}s`)

    // Encode each clip sequentially
    log.push(`[${ts()}] encoding ${scenes.length} clips (ping-pong + scale)`)
    const scaledPaths = []
    for (const { scene_index, buf } of clips) {
      const origPath   = join(jobDir, `orig_${scene_index}.mp4`)
      const ppPath     = join(jobDir, `pp_${scene_index}.mp4`)
      const scaledPath = join(jobDir, `scaled_${scene_index}.mp4`)
      await writeFile(origPath, buf)

      // Step 1: forward + reverse = 10s ping-pong cycle that starts and ends at the same frame.
      // The loop cut is invisible because position matches at both ends.
      await run(ffmpeg, [
        '-loglevel', 'error', '-i', origPath,
        '-filter_complex', '[0:v]reverse[r];[0:v][r]concat=n=2:v=1:a=0[out]',
        '-map', '[out]',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '34', '-an',
        '-y', ppPath,
      ])
      await unlink(origPath)

      // Step 2: loop the 10s ping-pong to fill the target duration and scale to 720p
      const args = ['-loglevel', 'error']
      if (clipDuration) args.push('-stream_loop', '-1')
      args.push('-i', ppPath,
        '-vf', 'scale=720:-2',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '34',
        '-maxrate', '1400k', '-bufsize', '2800k', '-an')
      if (clipDuration) args.push('-t', clipDuration.toFixed(3))
      args.push('-y', scaledPath)

      await run(ffmpeg, args)
      await unlink(ppPath)
      scaledPaths.push({ scene_index, path: scaledPath })
    }
    log.push(`[${ts()}] all clips encoded`)

    // Sort by scene order and concat
    scaledPaths.sort((a, b) => a.scene_index - b.scene_index)
    const listPath = join(jobDir, 'list.txt')
    await writeFile(listPath, scaledPaths.map(({ path }) => `file '${path}'`).join('\n'))

    // Final concat + audio mux
    const outputPath = join(jobDir, 'output.mp4')
    const concatArgs = ['-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listPath]
    if (audioPath) concatArgs.push('-i', audioPath, '-map', '0:v:0', '-map', '1:a:0')
    concatArgs.push('-c:v', 'copy')
    if (audioPath) concatArgs.push('-c:a', 'aac', '-b:a', '128k', '-shortest')
    concatArgs.push('-y', outputPath)

    log.push(`[${ts()}] running ffmpeg concat + mux`)
    await run(ffmpeg, concatArgs)
    log.push(`[${ts()}] ffmpeg done`)

    const outputBuf = await readFile(outputPath)
    const sizeMB = (outputBuf.length / 1024 / 1024).toFixed(1)
    log.push(`[${ts()}] output: ${sizeMB}MB`)
    if (parseFloat(sizeMB) > 45) throw new Error(`Output is ${sizeMB}MB — exceeds 45MB storage limit`)

    log.push(`[${ts()}] uploading final video`)
    const finalPath = `${project.user_id}/${project_id}/final.mp4`
    const { error: uploadErr } = await supabase.storage
      .from('project-assets')
      .upload(finalPath, outputBuf, { contentType: 'video/mp4', upsert: true })
    if (uploadErr) throw new Error(`Upload failed: ${uploadErr.message}`)

    const { data: urlData } = supabase.storage.from('project-assets').getPublicUrl(finalPath)
    await supabase.from('projects')
      .update({ video_url: urlData.publicUrl, status: 'complete', assembly_error: null })
      .eq('id', project_id)

    const totalSec = ((Date.now() - t0) / 1000).toFixed(1)
    log.push(`[${ts()}] COMPLETE in ${totalSec}s`)

    return res.status(200).json({ success: true, video_url: urlData.publicUrl, total_sec: totalSec, log })
  } catch (err) {
    log.push(`[${ts()}] FAILED: ${err.message}`)
    await supabase.from('projects')
      .update({ status: 'videos_ready', assembly_error: err.message })
      .eq('id', project_id)
      .catch(() => {})
    return res.status(500).json({ success: false, error: err.message, log })
  } finally {
    await rm(jobDir, { recursive: true, force: true }).catch(() => {})
  }
}
