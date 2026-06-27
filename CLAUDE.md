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

## Non-Negotiable Core: Photorealism System

These two components were validated to eliminate 2D illustration drift and
Seedance motion warping. A Gemini evaluation showed the drift was causing
lookalike scores of 5.4/10 vs photorealistic reference. After fixing, the user
confirmed "THE CLEANEST EDITION YET." They must be preserved. If a future
request would weaken or remove either of them, push back hard and explain the
tradeoff before making any change.

### 4. Photorealism Anchor (`api/generate-image.js`, Director prompt — `api/analyze.js`)
`generate-image.js` prepends a hardcoded `PHOTO_PREFIX` to the very start of
`fullPrompt` — before even the `style_guide` — so Flux sees the medium signal
before any historical vocabulary:
`"Photorealistic cinematic 35mm documentary footage set in pre-modern historical
Japan, rich saturated colors, high contrast cinematic lighting, vivid and vibrant,
crisp historical textures, zero contemporary or modern elements, zero illustration
or anime — "`

This prevents two failure modes: (1) illustration drift when period vocabulary
(Edo, merchant district) appears before the photorealism signal, and (2) Flux
anchoring to modern contemporary Japan rather than historical settings.

Every image_prompt in STEP 4 must also open with:
`"Photorealistic cinematic 35mm documentary footage —"`

The negative_prompt must include illustration tokens (ukiyo-e, woodblock, sumi-e,
etc.) AND modern anachronism tokens (taxi, cab, automobile, modern road, parking
lot, contemporary building, telephone pole, vending machine).

**Do not move PHOTO_PREFIX after the style_guide. Do not remove illustration or
anachronism tokens from the negative_prompt.**

### 5. Motion Artifact Prevention (Director prompt — `api/analyze.js`)
The MOTION CONSTRAINT in STEP 4 requires `motion_prompt` values to prefer moves
that push toward or pull away from the subject (dolly in/out, drone
ascent/descent, slow zoom). Lateral tracking across fine geometric surfaces —
roof tiles, lattice screens, carved wood — causes spatial warping in Seedance
2.0. Wide landscape pans are safe; tight architectural tracking is not.

**Do not remove the MOTION CONSTRAINT or soften it to a preference. It must
remain a hard constraint on motion_prompt generation.**

### 6. Vibrancy Rule (Director prompt — `api/analyze.js`)
The VIBRANCY RULE in STEP 3 mandates rich, saturated, high-contrast imagery
regardless of weather, season, or narrative mood. Dark scenes use deep rich
shadows, not desaturated grey. Snow scenes are crisp bright whites with vivid
contrast. Fire scenes are vivid amber/orange, not dull smoggy grey. This was
validated after the "Edo burned" script produced flat grey imagery.
**Do not remove the VIBRANCY RULE or allow the Director to choose muted,
desaturated, or flat palettes.**

### 7. Shot Diversity + Narrative Arc (Director prompt — `api/analyze.js`)
SHOT DIVERSITY RULE requires every video to contain all four shot types: wide
establishing, medium, extreme close-up detail, and dramatic action beat. The
extreme close-up detail shots (hands on tools, wax seals, wood grain) are what
viewers remember — plan at least 1–2 per video at or near the climax.
NARRATIVE ARC RULE requires the Director to map setup → tension → climax →
resolution before writing scenes. A sequence of crowd-walking-down-a-street
shots with no arc is a failure of direction.
**Do not remove SHOT DIVERSITY RULE or NARRATIVE ARC RULE.**

### 8. Character Face Rule (Director prompt — `api/analyze.js`)
Named individuals may be shown at three-quarter face angle, medium distance,
with dramatic side or rim lighting. Unnamed crowds always from behind. Extreme
close-up faces (filling the frame) never — this is the uncanny valley danger
zone. The rule allows character detail and demeanor without triggering bad AI
face generation.
**Do not allow straight-on flat-lit portraits or extreme face close-ups.**

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
