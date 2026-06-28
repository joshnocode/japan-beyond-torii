import { createClient } from '@supabase/supabase-js'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { writeFile, readFile, mkdir, rm, chmod, copyFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import ffmpegStaticPath from 'ffmpeg-static'

const DISSOLVE_DUR = 0.3
const GRADE_FILTER = 'eq=contrast=1.05:saturation=1.03,noise=alls=4:allf=t+u'

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

  // Deduplicate by scene_index before assembly — keep the row with a video_url,
  // then image_url, then whichever came first. This prevents repeated clips in
  // the final video even if duplicate rows exist in the database.
  const rawCount = (scenes || []).length
  const deduped = new Map()
  for (const s of (scenes || [])) {
    const existing = deduped.get(s.scene_index)
    if (!existing || (!existing.video_url && s.video_url)) deduped.set(s.scene_index, s)
  }
  const dedupedScenes = [...deduped.values()].sort((a, b) => a.scene_index - b.scene_index)
  const dupCount = rawCount - dedupedScenes.length

  // Replace scenes reference with deduplicated list
  const scenesForAssembly = dedupedScenes

  // Also detect duplicate video_url values (different indices, same clip file)
  const urlCount = new Map()
  for (const s of scenesForAssembly) { if (s.video_url) urlCount.set(s.video_url, (urlCount.get(s.video_url) || 0) + 1) }
  const sharedUrls = [...urlCount.entries()].filter(([, n]) => n > 1)

  const missing = scenesForAssembly.filter(s => !s.video_url)
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

    // Log dedup results
    if (dupCount > 0) log.push(`[${ts()}] ⚠ deduped ${dupCount} duplicate rows before assembly`)
    if (sharedUrls.length > 0) log.push(`[${ts()}] ⚠ ${sharedUrls.length} video URL(s) shared across scenes: ${sharedUrls.map(([u, n]) => `${n}×${u.split('/').pop()}`).join(', ')}`)

    // Download clips and audio in parallel
    log.push(`[${ts()}] downloading ${scenesForAssembly.length} clips + audio${dupCount > 0 ? ` (${dupCount} duplicates removed)` : ''}`)
    const [clips, audioBuf] = await Promise.all([
      Promise.all(scenesForAssembly.map(async (s) => {
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

    // Write audio and probe duration for safety-net loop calculation
    let audioPath = null
    let audioDurSec = null
    if (audioBuf) {
      audioPath = join(jobDir, 'audio.mp3')
      await writeFile(audioPath, audioBuf)
      log.push(`[${ts()}] audio: ${(audioBuf.length / 1024 / 1024).toFixed(1)}MB`)

      const probeOut = await new Promise(resolve =>
        execFile(ffmpeg, ['-i', audioPath], { maxBuffer: 10 * 1024 * 1024 },
          (_e, _o, stderr) => resolve(stderr || ''))
      )
      const m = probeOut.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/)
      if (m) {
        audioDurSec = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3])
        log.push(`[${ts()}] audio duration: ${audioDurSec.toFixed(1)}s`)
      } else {
        audioDurSec = project.brief?.estimated_duration_seconds || null
        log.push(`[${ts()}] audio duration (brief fallback): ${audioDurSec}s`)
      }
    }

    // Build per-scene duration map from director's brief.
    // Falls back to proportional average if brief data is missing.
    const briefScenes = project.brief?.scenes || []
    const briefDurMap = new Map(briefScenes.map(s => [s.scene_number - 1, s.duration_sec]))
    const totalBriefDur = briefScenes.reduce((sum, s) => sum + (s.duration_sec || 0), 0)
    const fallbackDur = (audioDurSec && scenesForAssembly.length)
      ? audioDurSec / scenesForAssembly.length
      : 5
    const getClipDur = (scene_index) => {
      const d = briefDurMap.get(scene_index)
      if (d && d > 0) return d
      // Scale fallback proportionally if director durations were partially set
      return totalBriefDur > 0 ? fallbackDur : 5
    }
    log.push(`[${ts()}] using director durations (fallback=${fallbackDur.toFixed(1)}s)`)

    // Encode each clip, looping it to match its director-assigned duration
    log.push(`[${ts()}] encoding ${scenesForAssembly.length} clips`)
    const scaledPaths = []
    for (const { scene_index, buf } of clips) {
      const origPath   = join(jobDir, `orig_${scene_index}.mp4`)
      const scaledPath = join(jobDir, `scaled_${scene_index}.mp4`)
      await writeFile(origPath, buf)

      const clipDur = getClipDur(scene_index)
      const args = ['-loglevel', 'error', '-stream_loop', '-1', '-i', origPath,
        '-vf', `scale=720:-2,${GRADE_FILTER}`,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '34',
        '-maxrate', '1400k', '-bufsize', '2800k', '-an',
        '-t', clipDur.toFixed(3),
        '-y', scaledPath]

      await run(ffmpeg, args)
      await unlink(origPath)
      scaledPaths.push({ scene_index, path: scaledPath })
    }
    log.push(`[${ts()}] all clips encoded`)

    // Sort by scene order
    scaledPaths.sort((a, b) => a.scene_index - b.scene_index)

    const mergedPath = join(jobDir, 'merged.mp4')
    const outputPath = join(jobDir, 'output.mp4')

    if (scaledPaths.length === 1) {
      // Single clip — no xfade needed, just copy
      await copyFile(scaledPaths[0].path, mergedPath)
      log.push(`[${ts()}] single clip, skipped xfade`)
    } else {
      // Build xfade filtergraph — dissolve transitions between every consecutive clip pair.
      // Offset is cumulative: each transition starts at sum(prevDurs) - n*DISSOLVE_DUR from timeline start.
      const inputArgs = scaledPaths.flatMap(({ path }) => ['-i', path])
      const filterParts = []
      let cumulativeOffset = 0
      for (let i = 1; i < scaledPaths.length; i++) {
        const prevDur = getClipDur(scaledPaths[i - 1].scene_index)
        cumulativeOffset += prevDur - DISSOLVE_DUR
        const inp = i === 1 ? '[0:v][1:v]' : `[xv${i - 1}][${i}:v]`
        const out = i === scaledPaths.length - 1 ? '[vout]' : `[xv${i}]`
        filterParts.push(`${inp}xfade=transition=dissolve:duration=${DISSOLVE_DUR}:offset=${cumulativeOffset.toFixed(3)}${out}`)
      }

      const xfadeArgs = ['-loglevel', 'error',
        ...inputArgs,
        '-filter_complex', filterParts.join(';'),
        '-map', '[vout]',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '34',
        '-maxrate', '1400k', '-bufsize', '2800k',
        '-an', '-y', mergedPath]
      log.push(`[${ts()}] running xfade filtergraph (${scaledPaths.length} clips, ${DISSOLVE_DUR}s dissolves)`)
      await run(ffmpeg, xfadeArgs)
      log.push(`[${ts()}] xfade done`)
    }

    // Mux audio into the merged video
    if (audioPath) {
      const muxArgs = ['-loglevel', 'error',
        '-i', mergedPath, '-i', audioPath,
        '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
        '-shortest', '-y', outputPath]
      log.push(`[${ts()}] muxing audio`)
      await run(ffmpeg, muxArgs)
      log.push(`[${ts()}] mux done`)
    } else {
      await copyFile(mergedPath, outputPath)
      log.push(`[${ts()}] no audio, using merged video as output`)
    }

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
