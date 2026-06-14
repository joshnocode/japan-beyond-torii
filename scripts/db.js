#!/usr/bin/env node
// Usage:
//   node scripts/db.js project <project_id>
//   node scripts/db.js projects
//   node scripts/db.js scenes <project_id>

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Load .env from project root
try {
  const env = readFileSync(join(__dirname, '../.env'), 'utf8')
  for (const line of env.split('\n')) {
    const [k, ...v] = line.split('=')
    if (k && !k.startsWith('#')) process.env[k.trim()] = v.join('=').trim()
  }
} catch {}

const url = process.env.VITE_SUPABASE_URL
const key = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !key) {
  console.error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in .env')
  process.exit(1)
}

const sb = createClient(url, key)

const [,, cmd, arg] = process.argv

async function project(id) {
  const { data, error } = await sb.from('projects').select('*').eq('id', id).single()
  if (error) return console.error('Error:', error.message)
  console.log('\n── Project ──────────────────────────')
  console.log('id:        ', data.id)
  console.log('title:     ', data.title)
  console.log('status:    ', data.status)
  console.log('video_url: ', data.video_url || '(none)')
  console.log('audio_url: ', data.audio_url ? '✓ set' : '(none)')
  console.log('user_id:   ', data.user_id)
  console.log('created:   ', data.created_at)
}

async function projects() {
  const { data, error } = await sb.from('projects').select('id,title,status,video_url,created_at').order('created_at', { ascending: false }).limit(20)
  if (error) return console.error('Error:', error.message)
  console.log('\n── Recent Projects ──────────────────')
  for (const p of data) {
    const vid = p.video_url ? '✓ video' : '      '
    console.log(`[${p.status.padEnd(16)}] ${vid}  ${p.id}  ${p.title?.slice(0,40) || '(untitled)'}`)
  }
}

async function scenes(projectId) {
  const { data, error } = await sb.from('scenes').select('scene_index,status,image_url,video_url,video_request_id').eq('project_id', projectId).order('scene_index')
  if (error) return console.error('Error:', error.message)
  console.log(`\n── Scenes for ${projectId} ──`)
  let imgDone = 0, vidDone = 0, errors = 0
  for (const s of data) {
    const img = s.image_url ? '✓img' : '    '
    const vid = s.video_url ? '✓vid' : '    '
    const req = s.video_request_id ? `queued(${s.video_request_id.slice(0,8)})` : ''
    const err = s.status === 'error' ? ' ← ERROR' : ''
    console.log(`  Scene ${String(s.scene_index + 1).padStart(2)}  ${img}  ${vid}  ${req}${err}`)
    if (s.image_url) imgDone++
    if (s.video_url) vidDone++
    if (s.status === 'error') errors++
  }
  console.log(`\n  Total: ${data.length} scenes | ${imgDone} images | ${vidDone} videos | ${errors} errors`)
}

switch (cmd) {
  case 'project':  await project(arg); break
  case 'projects': await projects(); break
  case 'scenes':   await scenes(arg); break
  default:
    console.log('Usage:')
    console.log('  node scripts/db.js projects')
    console.log('  node scripts/db.js project <id>')
    console.log('  node scripts/db.js scenes <id>')
}
