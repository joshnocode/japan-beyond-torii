import { createClient } from '@supabase/supabase-js'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { writeFile, readFile, mkdir, rm, chmod, copyFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import ffmpegStaticPath from 'ffmpeg-static'

const DISSOLVE_DUR = 0.3
const GRADE_FILTER = 'eq=contrast=1.05:saturation=1.03,noise=alls=4:allf=t+u'
const SFX_VOLUME = 0.2  // ambient SFX at 20% — Alfred narration clearly primary

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

// Convert seconds to ASS timestamp format H:MM:SS.cc
function toAssTime(sec) {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  const cs = Math.round((sec % 1) * 100)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

// Build an ASS subtitle file from ElevenLabs character-level alignment.
// Groups characters into words, then words into lines of wordsPerLine.
function buildAss(characters, starts, ends, wordsPerLine = 4, playResX = 720, playResY = 406) {
  // Build word list from character alignment
  const words = []
  let wordChars = ''
  let wordStart = null
  let wordEnd = null

  for (let i = 0; i < characters.length; i++) {
    const ch = characters[i]
    if (ch === ' ' || ch === '\n' || ch === '\r') {
      if (wordChars.trim()) {
        words.push({ text: wordChars.trim(), start: wordStart, end: wordEnd })
        wordChars = ''
        wordStart = null
        wordEnd = null
      }
    } else {
      if (wordStart === null) wordStart = starts[i]
      wordEnd = ends[i]
      wordChars += ch
    }
  }
  if (wordChars.trim()) words.push({ text: wordChars.trim(), start: wordStart, end: wordEnd })

  if (!words.length) return null

  // Group words into subtitle lines
  const lines = []
  for (let i = 0; i < words.length; i += wordsPerLine) {
    const group = words.slice(i, i + wordsPerLine)
    lines.push({
      text: group.map(w => w.text).join(' '),
      start: group[0].start,
      end: group[group.length - 1].end,
    })
  }

  // ASS file — white bold text, black outline, bottom-center, no shadow
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${playResX}
PlayResY: ${playResY}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,44,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,2.5,0,2,24,24,52,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`

  const dialogues = lines
    .map(l => `Dialogue: 0,${toAssTime(l.start)},${toAssTime(l.end)},Default,,0,0,0,,${l.text}`)
    .join('\n')

  return header + '\n' + dialogues + '\n'
}

async function generateSfx(apiKey, prompt, durationSec) {
  const resp = await fetch('https://api.elevenlabs.io/v1/sound-generation', {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg',
    },
    body: JSON.stringify({
      text: prompt,
      duration_seconds: Math.min(durationSec, 22.0),
      prompt_influence: 0.3,
    }),
  })
  if (!resp.ok) throw new Error(`ElevenLabs SFX HTTP ${resp.status}`)
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
    supabase.from('scenes').select('scene_index,video_url').eq('project_id', project_id).order('scene_index'),
  ])

  if (projErr || !project) return res.status(404).json({ error: 'Project not found' })

  // Deduplicate by scene_index — keep the row with a video_url.
  const rawCount = (scenes || []).length
  const deduped = new Map()
  for (const s of (scenes || [])) {
    const existing = deduped.get(s.scene_index)
    if (!existing || (!existing.video_url && s.video_url)) deduped.set(s.scene_index, s)
  }
  const dedupedScenes = [...deduped.values()].sort((a, b) => a.scene_index - b.scene_index)
  const dupCount = rawCount - dedupedScenes.length

  // Deduplicate by video_url — first occurrence wins.
  const seenUrls = new Set()
  const urlDedupedScenes = dedupedScenes.filter(s => {
    if (!s.video_url || !seenUrls.has(s.video_url)) {
      if (s.video_url) seenUrls.add(s.video_url)
      return true
    }
    return false
  })
  const urlDupCount = dedupedScenes.length - urlDedupedScenes.length
  const scenesForAssembly = urlDedupedScenes

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

    if (dupCount > 0) log.push(`[${ts()}] ⚠ deduped ${dupCount} duplicate scene_index rows before assembly`)
    if (urlDupCount > 0) log.push(`[${ts()}] ⚠ removed ${urlDupCount} scenes with duplicate video_url (same clip would have played twice)`)

    // Build brief lookups before download phase so they're available for SFX generation
    const briefScenes = project.brief?.scenes || []
    const briefDurMap = new Map(briefScenes.map(s => [s.scene_number - 1, s.duration_sec]))
    const totalBriefDur = briefScenes.reduce((sum, s) => sum + (s.duration_sec || 0), 0)
    const sfxPromptMap = new Map(briefScenes.map(s => [s.scene_number - 1, s.sound_effect_prompt]))
    const sfxApiKey = process.env.ELEVENLABS_API_KEY || process.env.VITE_ELEVENLABS_API_KEY

    // Fetch alignment JSON (stored by generate-audio when /with-timestamps was used)
    const { data: alignUrlData } = supabase.storage
      .from('project-assets')
      .getPublicUrl(`${project.user_id}/${project_id}/alignment.json`)
    const alignmentPromise = fetch(alignUrlData.publicUrl)
      .then(r => r.ok ? r.json() : null)
      .catch(() => null)

    // Generate SFX + download alignment in parallel with clip + narration downloads
    log.push(`[${ts()}] downloading ${scenesForAssembly.length} clips + audio${sfxApiKey ? ' + SFX' : ''}`)

    const sfxPromise = sfxApiKey
      ? Promise.all(scenesForAssembly.map(async (s) => {
          const prompt = sfxPromptMap.get(s.scene_index)
          const dur = briefDurMap.get(s.scene_index) || 5
          if (!prompt) return { scene_index: s.scene_index, buf: null }
          try {
            const buf = await generateSfx(sfxApiKey, prompt, dur)
            return { scene_index: s.scene_index, buf }
          } catch (err) {
            log.push(`[${ts()}] ⚠ SFX scene ${s.scene_index + 1} failed: ${err.message}`)
            return { scene_index: s.scene_index, buf: null }
          }
        }))
      : Promise.resolve(null)

    const [clips, audioBuf, sfxResults, alignment] = await Promise.all([
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
      sfxPromise,
      alignmentPromise,
    ])
    log.push(`[${ts()}] downloads complete${alignment ? ' (alignment captured)' : ''}`)

    // Write narration and probe duration
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

    const fallbackDur = (audioDurSec && scenesForAssembly.length)
      ? audioDurSec / scenesForAssembly.length
      : 5
    const getClipDur = (scene_index) => {
      const d = briefDurMap.get(scene_index)
      if (d && d > 0) return d
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

    // Build ambient SFX track — one audio segment per scene in timeline order,
    // looped/trimmed to the exact clip duration, then concatenated.
    let ambientPath = null
    if (sfxResults) {
      const sfxMap = new Map(sfxResults.map(r => [r.scene_index, r.buf]))
      const sfxSegPaths = []
      let sfxSuccessCount = 0

      for (const { scene_index } of scaledPaths) {
        const clipDur = getClipDur(scene_index)
        const sfxBuf = sfxMap.get(scene_index)
        const segPath = join(jobDir, `sfx_seg_${scene_index}.aac`)

        if (sfxBuf) {
          const rawPath = join(jobDir, `sfx_raw_${scene_index}.mp3`)
          await writeFile(rawPath, sfxBuf)
          // Loop raw SFX to exactly fill clip duration
          await run(ffmpeg, ['-loglevel', 'error',
            '-stream_loop', '-1', '-i', rawPath,
            '-t', clipDur.toFixed(3),
            '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
            '-y', segPath])
          await unlink(rawPath)
          sfxSuccessCount++
        } else {
          // Silent stereo placeholder keeps timeline sync for scenes without SFX
          await run(ffmpeg, ['-loglevel', 'error',
            '-f', 'lavfi', '-i', `aevalsrc=0:c=stereo:s=44100:d=${clipDur.toFixed(3)}`,
            '-c:a', 'aac', '-b:a', '128k',
            '-y', segPath])
        }
        sfxSegPaths.push(segPath)
      }

      if (sfxSuccessCount > 0) {
        const concatListPath = join(jobDir, 'sfx_concat.txt')
        await writeFile(concatListPath, sfxSegPaths.map(p => `file '${p}'`).join('\n'))
        ambientPath = join(jobDir, 'ambient.aac')
        await run(ffmpeg, ['-loglevel', 'error',
          '-f', 'concat', '-safe', '0', '-i', concatListPath,
          '-c:a', 'copy',
          '-y', ambientPath])
        log.push(`[${ts()}] SFX ambient track built (${sfxSuccessCount}/${scaledPaths.length} scenes with audio)`)
      } else {
        log.push(`[${ts()}] SFX skipped — all scene generations failed`)
      }
    } else {
      log.push(`[${ts()}] SFX skipped — no ELEVENLABS_API_KEY`)
    }

    const mergedPath = join(jobDir, 'merged.mp4')
    const outputPath = join(jobDir, 'output.mp4')

    if (scaledPaths.length === 1) {
      await copyFile(scaledPaths[0].path, mergedPath)
      log.push(`[${ts()}] single clip, skipped xfade`)
    } else {
      // Build xfade filtergraph — dissolve transitions between every consecutive clip pair
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

    // Burn subtitles into video if alignment data is available (non-fatal)
    // Probe merged.mp4 dimensions so ASS PlayRes matches actual video size
    let videoForMux = mergedPath
    if (alignment?.characters?.length) {
      try {
        const probeOut = await new Promise(resolve =>
          execFile(ffmpeg, ['-i', mergedPath], { maxBuffer: 10 * 1024 * 1024 },
            (_e, _o, stderr) => resolve(stderr || ''))
        )
        const dimMatch = probeOut.match(/(\d{2,4})x(\d{2,4})/)
        const vW = dimMatch ? parseInt(dimMatch[1]) : 720
        const vH = dimMatch ? parseInt(dimMatch[2]) : 406

        const assContent = buildAss(
          alignment.characters,
          alignment.character_start_times_seconds,
          alignment.character_end_times_seconds,
          4, vW, vH
        )
        if (assContent) {
          const assPath = join(jobDir, 'subs.ass')
          await writeFile(assPath, assContent)
          const mergedSubPath = join(jobDir, 'merged_sub.mp4')
          await run(ffmpeg, ['-loglevel', 'error',
            '-i', mergedPath,
            '-vf', `subtitles=${assPath}`,
            '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '34',
            '-maxrate', '1400k', '-bufsize', '2800k',
            '-an', '-y', mergedSubPath])
          videoForMux = mergedSubPath
          log.push(`[${ts()}] subtitles burned in (${alignment.characters.length} chars → ${vW}×${vH})`)
        }
      } catch (err) {
        log.push(`[${ts()}] ⚠ subtitle burn failed: ${err.message.slice(0, 200)} — continuing without`)
      }
    }

    // Mux audio — narration primary, ambient SFX in background
    if (audioPath && ambientPath) {
      // Mix: narration vol=1.0, SFX vol=0.2 — Alfred clearly primary
      const muxArgs = ['-loglevel', 'error',
        '-i', videoForMux, '-i', audioPath, '-i', ambientPath,
        '-filter_complex',
          `[1:a]volume=1.0[nar];[2:a]volume=${SFX_VOLUME}[sfx];[nar][sfx]amix=inputs=2:duration=first:dropout_transition=0[mixed];[mixed]alimiter=level_in=1:level_out=0.95:limit=0.95[out]`,
        '-map', '0:v:0', '-map', '[out]',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
        '-shortest', '-y', outputPath]
      log.push(`[${ts()}] muxing narration + SFX ambient (vol=${SFX_VOLUME})`)
      await run(ffmpeg, muxArgs)
      log.push(`[${ts()}] mux done`)
    } else if (audioPath) {
      const muxArgs = ['-loglevel', 'error',
        '-i', videoForMux, '-i', audioPath,
        '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
        '-shortest', '-y', outputPath]
      log.push(`[${ts()}] muxing narration only`)
      await run(ffmpeg, muxArgs)
      log.push(`[${ts()}] mux done`)
    } else if (ambientPath) {
      // No narration — play SFX at 60% so it's not too quiet as the sole audio
      const muxArgs = ['-loglevel', 'error',
        '-i', videoForMux, '-i', ambientPath,
        '-filter_complex', `[1:a]volume=0.6[sfx];[sfx]alimiter=level_in=1:level_out=0.95:limit=0.95[out]`,
        '-map', '0:v:0', '-map', '[out]',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
        '-shortest', '-y', outputPath]
      log.push(`[${ts()}] muxing SFX ambient only`)
      await run(ffmpeg, muxArgs)
      log.push(`[${ts()}] mux done`)
    } else {
      await copyFile(videoForMux, outputPath)
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
