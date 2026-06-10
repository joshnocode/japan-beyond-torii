import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

const envRaw = readFileSync('/Users/joshjackson/Desktop/japan-beyond-torii/.env.local', 'utf8')
const env = Object.fromEntries(
  envRaw.split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => [l.split('=')[0].trim(), l.slice(l.indexOf('=')+1).trim()])
)

const SUPABASE_URL = env.VITE_SUPABASE_URL
const SERVICE_KEY  = env.SUPABASE_SERVICE_ROLE_KEY
const MANIFEST_PATH = '/Users/joshjackson/Desktop/japan-beyond-torii/kawanakajima-manifest.json'
const AUDIO_PATH    = '/Users/joshjackson/Desktop/japan-beyond-torii/Alfred the Japanese Emissary .m4a'

function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`) }

log('Reading manifest…')
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
log(`  Title: ${manifest.title} — ${manifest.scenes.length} scenes`)

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false }
})

// Get user ID by email via admin API
log('Looking up user ID…')
const { data: { users }, error: listErr } = await supabase.auth.admin.listUsers()
if (listErr) { console.error('❌  listUsers failed:', listErr.message); process.exit(1) }
const user = users.find(u => u.email === 'hello@joshnocode.com')
if (!user) { console.error('❌  User hello@joshnocode.com not found'); process.exit(1) }
const userId = user.id
log(`  User ID: ${userId}`)

// Create project
log('Creating project record…')
const { data: proj, error: projErr } = await supabase.from('projects').insert({
  user_id: userId,
  title: manifest.title || 'Kawanakajima',
  status: 'processing',
  script: manifest.script || '',
  brief: manifest.brief || null,
  cost_cents: manifest.brief?.cost_estimate?.total_usd
    ? Math.round(manifest.brief.cost_estimate.total_usd * 100)
    : 0,
  thumbnail_url: manifest.scenes?.[0]?.image_url || null,
}).select().single()
if (projErr) { console.error('❌  Project insert failed:', projErr.message); process.exit(1) }
log(`  Project ID: ${proj.id}`)

// Insert scenes
log(`Inserting ${manifest.scenes.length} scenes…`)
const sceneRows = manifest.scenes.map((s) => ({
  project_id: proj.id,
  scene_index: s.scene_index,
  description: s.description || '',
  image_prompt: s.image_prompt || '',
  motion_prompt: s.motion_prompt || '',
  image_url: s.image_url || null,
  video_url: s.video_url || null,
  status: s.video_url ? 'complete' : s.image_url ? 'error' : 'draft',
}))
const { error: scenesErr } = await supabase.from('scenes').insert(sceneRows)
if (scenesErr) { console.error('❌  Scenes insert failed:', scenesErr.message); process.exit(1) }
log('  Scenes inserted ✓')

// Upload audio
log('Uploading audio…')
const audioBytes = readFileSync(AUDIO_PATH)
const storagePath = `${userId}/${proj.id}/audio.m4a`
const { error: uploadErr } = await supabase.storage
  .from('project-assets')
  .upload(storagePath, audioBytes, { contentType: 'audio/mp4', upsert: true })

if (uploadErr) {
  log(`  ⚠️  Audio upload failed: ${uploadErr.message}`)
} else {
  const { data: { publicUrl } } = supabase.storage.from('project-assets').getPublicUrl(storagePath)
  await supabase.from('projects').update({ audio_url: publicUrl }).eq('id', proj.id)
  log(`  Audio uploaded ✓`)
}

log('')
log('✅  Import complete!')
log(`   Project ID: ${proj.id}`)
log(`   Local: http://localhost:5174/project/${proj.id}`)
log(`   Vercel: https://japan-beyond-torii.vercel.app/project/${proj.id}`)
