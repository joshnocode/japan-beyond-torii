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

  // Validate all video URLs before starting heavy work
  console.log('[assemble] validating', scenes.length, 'video URLs')
  const urlChecks = await Promise.all(
    (scenes || []).map(async (scene) => {
      try {
        const r = await fetch(scene.video_url, { method: 'HEAD' })
        return { idx: scene.scene_index + 1, ok: r.ok, status: r.status }
      } catch (e) {
        return { idx: scene.scene_index + 1, ok: false, status: e.message }
      }
    })
  )
  const badUrls = urlChecks.filter(c => !c.ok)
  if (badUrls.length) {
    return res.status(400).json({
      error: `${badUrls.length} video URL(s) inaccessible (scenes: ${badUrls.map(c => `${c.idx} [${c.status}]`).join(', ')}). Re-generate those scenes and retry.`
    })
  }

  const jobDir = join(tmpdir(), `assembly_${Date.now()}`)
  await mkdir(jobDir, { recursive: true })

  try {
    const t0 = Date.now()
    const ffmpeg = await getFFmpeg()

    // Download all clips + audio in parallel
    console.log('[assemble] downloading', scenes.length, 'clips + audio in parallel')
    let audioExt = null
    const audioPromise = project.audio_url ? (async () => {
      const resp = await fetch(project.audio_url)
      if (resp.ok) {
        audioExt = (project.audio_url.split('.').pop().split('?')[0] || 'mp3').toLowerCase()
        await writeFile(join(jobDir, `audio.${audioExt}`), Buffer.from(await resp.arrayBuffer()))
        console.log('[assemble] audio downloaded:', audioExt)
      }
    })() : Promise.resolve()

    await Promise.all([
      ...scenes.map(async (scene, i) => {
        const resp = await fetch(scene.video_url)
        if (!resp.ok) throw new Error(`Scene ${scene.scene_index + 1} download failed (HTTP ${resp.status})`)
        await writeFile(join(jobDir, `scene_${i}.mp4`), Buffer.from(await resp.arrayBuffer()))
      }),
      audioPromise,
    ])
    console.log(`[assemble] all downloads done in ${Math.round((Date.now() - t0) / 1000)}s`)

    // Write SRT and concat list
    await writeFile(join(jobDir, 'subs.srt'), buildSRT(scenes, project.brief))
    const listPath = join(jobDir, 'list.txt')
    await writeFile(listPath, scenes.map((_, i) => `file '${join(jobDir, `scene_${i}.mp4`)}'`).join('\n'))

    const srtPath = join(jobDir, 'subs.srt')
    const outputPath = join(jobDir, 'output.mp4')

    // Use -f concat demuxer so FFmpeg processes clips sequentially (one decoder context
    // at a time) instead of opening all 35 simultaneously via filter_complex.
    // This avoids the massive overhead that caused the 261s+ timeout.
    const buildArgs = (withSubs) => {
      const args = ['-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listPath]
      if (audioExt) args.push('-i', join(jobDir, `audio.${audioExt}`))

      const vf = withSubs
        ? `scale=720:-2,subtitles=${srtPath}:force_style='FontSize=18,PrimaryColour=&HFFFFFF&,OutlineColour=&H00000000,Outline=2,BorderStyle=1,Alignment=2,MarginV=40'`
        : 'scale=720:-2'
      args.push('-vf', vf)

      if (audioExt) args.push('-map', '0:v:0', '-map', '1:a:0', '-c:a', 'aac', '-b:a', '128k', '-shortest')
      // CRF 32 + maxrate cap keeps 35 × 5s clips well under Supabase's 50MB free tier limit
      args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '32', '-maxrate', '1800k', '-bufsize', '3600k', '-y', outputPath)
      return args
    }

    const tEncode = Date.now()
    console.log('[assemble] starting ffmpeg encode with concat demuxer (sequential clip processing)')
    try {
      await run(ffmpeg, buildArgs(true))
      console.log('[assemble] encode with subtitles done')
    } catch (subErr) {
      console.log('[assemble] subtitle encode failed, retrying without subs:', subErr.message.slice(0, 300))
      await run(ffmpeg, buildArgs(false))
      console.log('[assemble] encode without subtitles done')
    }
    console.log(`[assemble] encode completed in ${Math.round((Date.now() - tEncode) / 1000)}s`)

    // Upload to Supabase storage
    const outputBuf = await readFile(outputPath)
    const sizeMB = Math.round(outputBuf.length / 1024 / 1024)
    console.log('[assemble] output size:', sizeMB, 'MB — uploading')
    if (sizeMB > 49) {
      throw new Error(`Output is ${sizeMB} MB — exceeds Supabase 50 MB limit. Contact support to upgrade storage.`)
    }

    const storagePath = `${project.user_id}/${project_id}/final.mp4`
    const { error: uploadErr } = await supabase.storage
      .from('project-assets')
      .upload(storagePath, outputBuf, { contentType: 'video/mp4', upsert: true })
    if (uploadErr) throw new Error(`Upload failed: ${uploadErr.message}`)

    const { data: urlData } = supabase.storage.from('project-assets').getPublicUrl(storagePath)
    const videoUrl = urlData.publicUrl

    await supabase.from('projects').update({ video_url: videoUrl, status: 'complete' }).eq('id', project_id)
    console.log(`[assemble] complete in ${Math.round((Date.now() - t0) / 1000)}s total:`, videoUrl)

    return res.status(200).json({ video_url: videoUrl })
  } catch (err) {
    console.error('[assemble-video] error:', err.message)
    return res.status(500).json({ error: err.message || 'Assembly failed' })
  } finally {
    await rm(jobDir, { recursive: true, force: true }).catch(() => {})
  }
}
