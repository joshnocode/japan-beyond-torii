#!/usr/bin/env node
// Usage:
//   node scripts/db.js project <project_id>
//   node scripts/db.js projects
//   node scripts/db.js scenes <project_id>

import pg from 'pg'
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

const connStr = process.env.DATABASE_URL
if (!connStr) {
  console.error('Missing DATABASE_URL in .env')
  console.error('Add: DATABASE_URL=postgresql://postgres:[password]@db.hdjmcjgpqmltrwiwltnr.supabase.co:5432/postgres')
  process.exit(1)
}

const client = new pg.Client({ connectionString: connStr, ssl: { rejectUnauthorized: false } })
await client.connect()

const [,, cmd, arg] = process.argv

async function project(id) {
  const { rows } = await client.query(
    'SELECT id, title, status, video_url, audio_url, user_id, created_at FROM projects WHERE id = $1',
    [id]
  )
  if (!rows.length) return console.log('Project not found:', id)
  const d = rows[0]
  console.log('\n── Project ──────────────────────────')
  console.log('id:        ', d.id)
  console.log('title:     ', d.title)
  console.log('status:    ', d.status)
  console.log('video_url: ', d.video_url || '(none)')
  console.log('audio_url: ', d.audio_url ? '✓ set' : '(none)')
  console.log('user_id:   ', d.user_id)
  console.log('created:   ', d.created_at)
}

async function projects() {
  const { rows } = await client.query(
    `SELECT id, title, status, video_url, created_at
     FROM projects ORDER BY created_at DESC LIMIT 20`
  )
  console.log('\n── Recent Projects ──────────────────')
  for (const p of rows) {
    const vid = p.video_url ? '✓ video' : '       '
    console.log(`[${p.status.padEnd(16)}] ${vid}  ${p.id}  ${(p.title || '(untitled)').slice(0, 40)}`)
  }
}

async function scenes(projectId) {
  const { rows } = await client.query(
    `SELECT scene_index, status, image_url, video_url, video_request_id
     FROM scenes WHERE project_id = $1 ORDER BY scene_index`,
    [projectId]
  )
  if (!rows.length) return console.log('No scenes found for project:', projectId)
  console.log(`\n── Scenes for ${projectId} ──`)
  let imgDone = 0, vidDone = 0, errors = 0
  for (const s of rows) {
    const img = s.image_url ? '✓img' : '    '
    const vid = s.video_url ? '✓vid' : '    '
    const req = s.video_request_id ? `queued(${s.video_request_id.slice(0, 8)})` : ''
    const err = s.status === 'error' ? ' ← ERROR' : ''
    console.log(`  Scene ${String(s.scene_index + 1).padStart(2)}  ${img}  ${vid}  ${req}${err}`)
    if (s.image_url) imgDone++
    if (s.video_url) vidDone++
    if (s.status === 'error') errors++
  }
  console.log(`\n  Total: ${rows.length} scenes | ${imgDone} images | ${vidDone} videos | ${errors} errors`)
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

await client.end()
