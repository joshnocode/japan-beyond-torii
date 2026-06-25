# Japan Beyond The Torii — Architecture Notes

## Non-Negotiable Core: Visual Continuity System

These three components were implemented together and validated to produce
cinematic continuity across AI-generated scenes. They must be preserved as a
unit. If a future request would weaken or remove any of them, push back hard
and explain the tradeoff before making any change.

### 1. Locked Lighting (Director prompt — `api/analyze.js`)
The style guide (STEP 3) requires `COLOR_TEMP`, `TIME_OF_DAY`, and `LIGHT_DIR`
locked for the entire video. Every scene shares the same ambient light quality.
This prevents warm-gold scene 3 cutting to cool-blue scene 4.
**Do not remove these fields from the style guide schema.**

### 2. Visual Anchoring (Director prompt — `api/analyze.js`)
The VISUAL CONTINUITY RULE in STEP 4 requires consecutive scenes in the same
physical location to name a specific shared architectural feature, landmark, or
natural element in the image_prompt. This creates the feeling of a camera
moving through one world rather than cutting between unrelated images.
**Do not soften this to a guideline — it must remain a mandatory rule.**

### 3. Img2img Reference Chaining (`api/generate-image.js`, `src/pages/ProjectPage.jsx`)
Scene 1's generated image is passed as `image_prompt` at strength `0.12` to
every subsequent Flux Pro Ultra call. This bleeds scene 1's color temperature
and atmospheric mood into all downstream generations without constraining
composition. The strength is intentionally low (0.12) — do not raise it above
~0.20 or compositions become too similar.
**Do not remove `reference_image_url` from the generate-image API or the
generation loop in ProjectPage.**

---

## Other Architectural Decisions

### Human Figure Rule (Director prompt — `api/analyze.js`)
Binary test per scene: if the `script_excerpt` contains a named individual OR
an explicit human action verb → figure allowed (from behind/rear only, never
facing camera). Otherwise → no human figures. Architecture, landscape, objects.
This is a mandatory rule, not a soft default.

### Duration is word-count-proportional, not AI-assigned
`parseResponse` in `api/analyze.js` overrides Claude's `duration_sec` values
with proportional calculations based on word count. The server's
`estimatedDurSec` (words / 130 WPM × 60) is authoritative. Claude's timing
guesses are discarded. Do not give Claude control over duration.

### Scene insert chunking (Supabase)
Scenes are inserted in chunks of 20 (`CHUNK = 20` in `NewProjectPage.jsx`).
Supabase PostgREST silently truncates bulk inserts at `max_rows`. Do not
replace chunked inserts with a single batch insert.

### Memory limit (Vercel Hobby plan)
`vercel.json` caps serverless function memory at 2048MB. The assemble/batch
functions previously requested 3008MB which silently blocked all Production
deployments. Do not raise memory above 2048MB without upgrading the Vercel plan.

### SSE for analysis endpoint
`api/analyze.js` uses Server-Sent Events (not a plain POST response) to keep
iOS Safari alive during long Claude generations (60–150s). Pings every 10s.
Do not convert this to a regular JSON response.
