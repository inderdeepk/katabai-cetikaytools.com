# Katab Pet Collection Implementation Plan

## 1. Product Decision

Katab will have a collection of five independently raised provider pets, with one active companion shown at a time.

- Ollama feeds Ollie.
- Unsloth feeds Slothy.
- OpenAI feeds Sparky.
- Anthropic feeds Clyde.
- DeepSeek feeds Pearl.
- Each provider pet keeps permanent XP and progresses independently.
- Crossbreeds are permanent, selectable forms unlocked by meaningful progress with two provider pets.
- Mixie is a permanent collection reward unlocked by progressing all five provider pets.
- The active companion either follows the current provider or remains pinned by the user.

This replaces the current behavior where one global companion changes species from cumulative provider percentages.

## 2. Goals

1. Make pet identity predictable: provider usage always feeds that provider's pet.
2. Let users discover and raise every pet without losing earlier progress.
3. Keep only one active companion in the main interface to avoid visual clutter.
4. Make crossbreeds rewards rather than automatic mutations.
5. Make Mixie rare, understandable, and permanently unlocked.
6. Keep collection progression independent from analytics retention and date-range filters.
7. Preserve the existing token breakdown, provider summaries, exports, and privacy guarantees.
8. Use the existing PNG sprite sets with clean fallbacks while unfinished Mixie and accent assets are delivered.

## 3. Non-Goals

- Showing multiple animated pets simultaneously in the chat window.
- Trading, networking, cloud synchronization, or competitive features.
- Backfilling usage from old chat history that was never recorded in the token ledger.
- Giving every named growth stage a separate hand-drawn sprite set in the first release.
- Generating arbitrary multi-part creature bodies at runtime.
- Renaming pets in the first release.

## 4. Core Progression Rules

### 4.1 Permanent provider XP

Each recorded usage event adds `promptTokens + completionTokens` to exactly one provider pet.

- Exact and estimated tokens both grant XP, matching the existing token ledger.
- Completed, stopped, and intermediate tool-call model turns grant token XP because all consume provider resources.
- `replyCount` increments for completed or stopped responses, but not intermediate `tool-call-turn` events.
- Duplicate event IDs never grant XP twice.
- Turning off token tracking also pauses pet progression.
- Resetting the usage ledger resets the pet collection after the existing confirmation flow.
- Pruning daily analytics never removes pet XP or lowers a pet's stage.

### 4.2 Per-pet stage thresholds

The old global thresholds are divided across the five provider pets so completing all five remains a long-term goal without requiring 250 million tokens.

| Stage | Provider Pet XP | Sprite Family |
|---|---:|---|
| Unhatched Egg | 0 | Provider egg |
| Hatchling | 1 | Baby |
| Sprout | 10,000 | Baby |
| Scholar | 100,000 | Adult |
| Sage | 1,000,000 | Adult |
| Archmage | 10,000,000 | Adult |

Reaching Archmage with all five pets therefore requires at least 50 million total provider tokens, equal to the current global Archmage threshold.

### 4.3 Visual differentiation between stages

The delivered art has egg, baby, and adult families rather than five unique bodies. Stage remains visible through size, framing, labels, and restrained effects:

- Egg: provider egg sprite.
- Hatchling: baby sprite at approximately 85% of its display slot.
- Sprout: baby sprite at full baby size with a stage badge.
- Scholar: adult sprite at approximately 85% of its display slot.
- Sage: full adult sprite with a subtle aura.
- Archmage: full adult sprite with a stronger aura and highest-stage badge.

Effects must not recolor or obscure the supplied artwork. They should respect dark and light themes and GNOME's reduced-animation setting.

## 5. Active Companion Rules

Katab supports two selection modes:

### Follow Provider (default)

- The active companion matches the currently selected model provider.
- Selecting a provider that has never been used shows that provider's egg.
- Its first recorded response hatches the egg.
- Switching providers changes the displayed companion but does not change or reset any pet.

### Pinned

- The user can pin any provider pet, unlocked crossbreed form, or Mixie.
- Provider changes continue feeding the provider that generated the response, not the pinned pet.
- If a saved pinned form becomes invalid after a ledger reset, Katab falls back to Follow Provider.

The collection view must always provide a clear `Follow Current Provider` action so pinning is reversible.

## 6. Crossbreed Rules

### 6.1 Unlocking a pair

A crossbreed pair unlocks permanently when both provider pets reach Sprout.

- Five pets produce ten unordered pair unlocks.
- A pair is stored once using a stable, alphabetically sorted key such as `ollama|openai`.
- Unlocking a pair makes both visual directions selectable.
- Example: one unlock permits both Sparky with Ollie's accent and Ollie with Sparky's accent.
- Migrated users who already satisfy a pair receive it silently to avoid a burst of old notifications.

This rule is based on durable pet progress rather than a rolling provider percentage. It needs no conversation-history tracking and remains understandable after long periods of inactivity.

### 6.2 Rendering a crossbreed

- The selected primary provider supplies the base body and stage.
- The selected secondary provider supplies one 32x32 accent overlay.
- The base pet's XP determines the displayed growth stage.
- Crossbreeds do not own separate XP.
- Only one accent is rendered at a time to keep the sprite readable.
- The UI displays both provider names and icons so the combination is not conveyed by color alone.

Overlay placement requires a small anchor map by base species and sprite family because the silhouettes differ. Each anchor defines offset and scale for baby and adult bodies. Missing accent files fall back to a small provider icon badge without blocking selection.

### 6.3 Crossbreed form identifiers

Use stable string identifiers at UI and settings boundaries:

```text
provider:openai
crossbreed:openai:ollama
mixie
```

For a crossbreed, the first provider is the base and the second is the accent. Persistence validates every identifier before rendering it.

## 7. Mixie Rules

Mixie is a collection-completion companion, not the default result of using several providers.

### Unlock condition

- All five provider pets must reach Sprout.
- Mixie unlocks permanently as soon as the final requirement is met.
- The locked Mixie card shows the existing patchwork egg and a `0/5 pets at Sprout` style requirement.

### Progress after unlocking

Mixie does not receive direct XP. Its stage is the lowest stage shared by all five provider pets:

```text
Mixie stage = minimum stage rank among Ollie, Slothy, Sparky, Clyde, and Pearl
```

This turns Mixie into a visible measure of collection mastery. Raising the weakest provider pet advances Mixie without creating a sixth token bucket.

Mixie stage changes emit `mixie-stage-up` events and use their own acknowledged-stage list, so advancing the weakest pet cannot repeat an earlier Mixie celebration after reload.

### Asset fallback

- Before unlock: `egg_mixie.png`.
- Hatchling and Sprout: Mixie baby idle frames.
- Scholar, Sage, and Archmage: Mixie adult idle frames.
- Until Mixie sleep, tip, and celebrate poses exist, use the appropriate idle frame instead of hiding or substituting another species.

## 8. Persistent Data Model

Increase the token-usage store version from 2 to 3 and add a permanent `collection` object beside the prunable `days` analytics.

```json
{
  "version": 3,
  "trackingStartedAt": 0,
  "lastUpdatedAt": 0,
  "recentEventIds": [],
  "days": {},
  "collection": {
    "pets": {
      "ollama": {
        "xp": 0,
        "replyCount": 0,
        "hatchedAt": 0,
        "lastFedAt": 0,
        "celebratedStages": []
      }
    },
    "unlockedPairs": {
      "ollama|openai": {
        "unlockedAt": 0
      }
    },
    "mixie": {
      "unlockedAt": 0,
      "celebrated": false,
      "celebratedStages": []
    }
  }
}
```

All five provider entries are normalized during every load, even when a saved store is partial or manually edited.

### GSettings additions

User display preferences belong in GSettings rather than the analytics ledger:

| Key | Type | Default | Purpose |
|---|---|---|---|
| `pet-selection-mode` | string | `follow-provider` | `follow-provider` or `pinned` |
| `pet-pinned-form` | string | empty | Stable form ID selected by the user |

No setting is needed for unlocks or XP. Those remain in the local token-usage store and are included in exports.

## 9. Store Migration

Migration from version 2 must be deterministic, non-destructive, and silent.

1. Preserve all existing daily analytics and metadata.
2. Create all five pet records.
3. Derive each pet's XP by summing that provider's retained daily buckets.
4. Derive `replyCount` from completed and stopped provider statuses, excluding `tool-call-turn`.
5. Set `hatchedAt` from the earliest retained day containing provider usage.
6. Set `lastFedAt` from the latest retained day containing provider usage.
7. Mark every stage up to the migrated current stage as already celebrated.
8. Unlock all qualifying Sprout pairs without notifications.
9. Unlock Mixie silently if all five migrated pets already meet its requirement.
10. Preserve the old global milestone data for compatibility during the migration release, but stop using it for pet-stage decisions.

Previously pruned or never-recorded history cannot be reconstructed and must not be inferred from chat files.

## 10. Domain API Changes

Move shared pet definitions and pure calculations into a small new module, tentatively `petCollection.js`:

- Provider-to-pet metadata.
- Stage thresholds and rank lookup.
- Form parsing and validation.
- Stable pair-key generation.
- Crossbreed and Mixie unlock predicates.
- Sprite descriptor selection.
- Active companion resolution.

`tokenUsageManager.js` remains the persistence owner and gains APIs such as:

```javascript
TokenUsageManager.getCollectionState()
TokenUsageManager.getPetState(provider)
TokenUsageManager.getUnlockedCrossbreeds()
TokenUsageManager.getActiveCompanion(selection)
```

`recordUsageEvent()` updates daily analytics and permanent collection progress in the same mutation, then returns an event array rather than one global celebration:

```javascript
{
  recorded: true,
  events: [
    { type: 'pet-hatched', provider: 'openai' },
    { type: 'pet-stage-up', provider: 'openai', stageKey: 'sprout' },
    { type: 'crossbreed-unlocked', providers: ['ollama', 'openai'] },
    { type: 'mixie-unlocked' }
  ]
}
```

The extension batches simultaneous unlock messages so one stage-up cannot produce four disruptive notifications.

## 11. Sprite Rendering Architecture

Create one reusable shell-side sprite actor rather than duplicating image and timer logic in each UI surface.

Responsibilities:

- Resolve a validated form and pose to an extension-relative PNG path.
- Render provider, crossbreed, Mixie, and egg states.
- Alternate `idle_01` and `idle_02` every 800 ms while visible.
- Render a static first frame when GNOME animations are disabled.
- Temporarily switch to `tip` for 1.2 seconds when a user message is accepted.
- Temporarily switch to `celebrate` for 2.4 seconds for hatch, stage, and unlock events.
- Switch to `sleep` after 30 seconds without chat interaction when the full companion card is visible.
- Wake immediately on prompt submission, provider change, pet selection, or a new collection event.
- Fall back in this order: requested pose, `idle_01`, egg, text face.
- Cache loaded file icons/textures rather than decoding the same PNG repeatedly.
- Remove every GLib timeout and signal when hidden or destroyed.

Only the large companion actor should animate. Collection thumbnails and the panel-menu snapshot use static frames to limit shell work.

Crossbreed placement data uses normalized offsets relative to the sprite slot rather than monitor pixels:

```javascript
const PET_ACCENT_ANCHORS = {
  ollama: {
    baby: { x: 0.68, y: 0.12, scale: 0.72 },
    adult: { x: 0.70, y: 0.16, scale: 1.0 },
  },
};
```

The values above illustrate the data shape only. Final anchors must be calibrated against every delivered accent at baby and adult sizes.

## 12. User Interface Plan

### 12.1 Active companion card

Replace the current text face in the Token Breakdown companion card with the sprite actor while retaining useful text:

- Pet or form name.
- Current stage.
- Provider source or crossbreed pairing.
- Permanent XP and progress to the next stage.
- Mood/flavor text.
- `View Collection` action.
- Current `Following Provider` or `Pinned` state.

The existing local/cloud mood can remain a recent-usage characteristic, but it must not determine species, stage, or unlocks.

### 12.2 Collection view

Add a collection panel reachable from the active companion card inside Token Breakdown.

- Build two-column rows explicitly; GNOME Shell St CSS does not support `flex-wrap`.
- Show five provider pet entries and one Mixie entry.
- Each entry shows a static sprite, pet name, provider, stage, XP progress, and active status.
- Unhatched pets show their provider egg and `Use this provider to hatch`.
- Selecting a provider pet pins it and returns to the companion view.
- Mixie remains visibly locked with requirement progress until unlocked.
- Provide a top-level `Follow Current Provider` action.

Do not place a full card inside another card. Collection items are peer items in an unframed panel section.

### 12.3 Pet detail and forms

Selecting a collection entry can open a detail panel containing:

- Larger static or animated preview.
- Exact XP and next-stage requirement.
- Reply count and last-fed date.
- Available crossbreed accents for that base pet.
- A `Make Companion` action.

Locked pair rows explain the requirement using pet names, for example `Raise Ollie and Sparky to Sprout`.

### 12.4 Top-panel menu snapshot

- Replace the text companion face with a small static sprite.
- Keep the selected-range token total and provider share bar unchanged.
- The title reflects the active companion, not the selected range's leading provider.
- Activating the row still opens Token Breakdown.

### 12.5 Preferences

Add a small `Pet Companion` group beneath AI Token Breakdown:

- Selection mode row: Follow Current Provider or Pinned.
- Pinned form summary with an `Open Collection` explanation; actual form selection remains in the richer shell collection UI.
- Existing celebration toggle applies to hatch, stage, crossbreed, and Mixie events.
- Reset copy explicitly states that it resets analytics, all pet XP, and unlocks.

Preferences must mirror external GSettings changes using the existing synchronization helpers.

## 13. Asset Plan

### Available now

- Six egg sprites, including Mixie's egg.
- Complete baby and adult pose sets for Ollie, Slothy, Sparky, Clyde, and Pearl.
- 51 PNG files in total.

### Required for complete crossbreed and Mixie presentation

- Four Mixie idle frames: two baby and two adult.
- Five provider accent overlays.

### Optional follow-up assets

- Mixie baby/adult sleep, tip, and celebrate poses.
- Stage badge icons.

Runtime work must tolerate every optional or pending file being absent. Asset readiness must never break the usage panel.

## 14. Implementation Phases

### Current implementation status

- Phases 1–4 and Phase 7 are implemented and validated with focused tests, schema compilation, syntax checks, and a live GNOME Shell reload.
- Phase 5 behavior is implemented, including all directional forms and provider-logo fallbacks. The five custom accent PNGs remain an artwork deliverable.
- Phase 6 behavior is implemented, including locked progress, shared-stage progression, selection, events, and safe egg/text fallbacks. The four Mixie idle PNGs remain an artwork deliverable.

### Phase 1: Domain model and migration

Files: `petCollection.js`, `tokenUsageManager.js`

1. Add pet metadata, stage helpers, form parsing, and pair-key helpers.
2. Add version 3 collection state and migration.
3. Update `recordUsageEvent()` to grant provider XP atomically.
4. Return structured collection events.
5. Make pruning leave collection progress untouched.
6. Add collection query and active-resolution APIs.
7. Verify duplicate events, reset, export, and malformed-store normalization.

Exit criterion: collection state is correct in isolation while the existing `buildCompanionState()` UI path remains temporarily unchanged. Phase 2 switches rendering to the new collection APIs only after migration and XP mutation are verified.

### Phase 2: Base sprite renderer

Files: `extension.js`, `stylesheet.css`, optionally a focused sprite module

1. Implement safe asset resolution and sprite fallbacks.
2. Render eggs, baby sprites, and adult sprites.
3. Add visible-only idle animation and cleanup.
4. Add stage size/aura modifiers.
5. Replace the full companion text face while retaining fallback text.

Exit criterion: all five provider pets render correctly in dark and light themes at egg, baby, and adult stages.

### Phase 3: Collection and selection UI

Files: `extension.js`, `stylesheet.css`, schema XML, `prefs.js`, `prefs.css`

1. Add Follow Provider and Pinned settings.
2. Build the collection and pet-detail panels.
3. Add pin/unpin behavior and invalid-pin fallback.
4. Replace the panel-menu face with a static sprite.
5. Update reset and preference copy.

Exit criterion: users can inspect all pets, pin one, return to follow mode, and preserve selection across shell reloads.

### Phase 4: Celebrations and poses

Files: `extension.js`, `tokenUsageManager.js`

1. Replace the single global stage celebration with structured pet events.
2. Add hatch and per-pet stage messages.
3. Batch simultaneous crossbreed unlocks.
4. Trigger temporary tip and celebrate poses.
5. Respect in-chat and desktop notification settings independently.

Exit criterion: every collection event is announced once and never repeats after reload.

### Phase 5: Crossbreeds

Files: `petCollection.js`, `extension.js`, `stylesheet.css`, `sprites/accents/`

1. Add pair unlock calculation and migration behavior.
2. Add base/accent form selection.
3. Add per-species baby/adult overlay anchors.
4. Add missing-asset provider-icon fallback.
5. Verify all 20 directional visual combinations.

Exit criterion: each qualifying pair unlocks once, both directions are selectable, and overlays remain aligned at supported display scales.

Development may use the provider-icon fallback, but production completion of this phase requires all five accent PNGs.

### Phase 6: Mixie

Files: `petCollection.js`, `extension.js`, `stylesheet.css`, `sprites/mixie/`

1. Add locked progress card using Mixie's egg.
2. Add all-five-Sprout unlock.
3. Derive Mixie's stage from the weakest provider pet.
4. Add Mixie selection, animation, fallback poses, and one-time celebration.

Exit criterion: Mixie cannot unlock early, never relocks, and advances only when all five pets share the next stage.

The locked card and state logic can be developed with the existing egg, but production completion of this phase requires both baby idle frames and both adult idle frames.

### Phase 7: Documentation and release polish

Files: `README.md`, `Documentation/Help/UserGuide.md`, `PET_SPRITE_CHECKLIST.md`

1. Replace dominant-provider/Mixie-percentage documentation.
2. Document independent XP, selection modes, crossbreed unlocks, and Mixie requirements.
3. Update the sprite checklist status and totals as assets arrive.
4. Document migration, retention independence, reset behavior, and local storage.

Exit criterion: product copy matches the implemented rules exactly.

## 15. Validation Strategy

### Automated and focused checks

- Fresh version 3 store creates five normalized pet records.
- Version 2 migration derives the correct provider XP and never changes daily totals.
- Partial and malformed collection objects normalize safely.
- Duplicate event IDs do not change analytics or pet XP.
- Tool-call turns grant XP but do not increment visible reply count.
- Every exact stage boundary returns the expected stage.
- Pruning all eligible daily buckets does not reduce collection XP or stages.
- Reset clears analytics, XP, unlocks, and invalidates a pinned form.
- Pair keys are order-independent and every pair unlocks once.
- A crossbreed form cannot select the same provider twice.
- Mixie remains locked until all five pets reach Sprout.
- Mixie's stage equals the minimum core-pet stage.
- Each Mixie stage celebration is acknowledged once across reloads.
- Invalid or missing assets follow the documented fallback chain.
- Sprite timers stop when actors are hidden or destroyed.

### Repository checks after each phase

- Run editor diagnostics on every touched file.
- Run JavaScript syntax checks for changed modules.
- Run `glib-compile-schemas schemas/` after schema changes.
- Run CSS brace checks and verify no unsupported St properties are introduced.
- Run focused migration/state probes under GJS.
- Inspect the final diff for unrelated formatting or generated-file churn.

### Manual GNOME Shell checks

- Fresh install with no usage.
- Migration from a populated version 2 ledger.
- Follow-provider switching across all five providers.
- Pinned companion while another provider receives XP.
- Hatch, stage-up, crossbreed, and Mixie celebrations.
- Dark and light themes.
- 100%, 125%, and 200% display scaling where available.
- Narrow and normal chat window sizes.
- Animations enabled and disabled.
- Shell reload and extension disable/enable with no orphan timers or warnings.
- Missing Mixie/accent asset behavior.

## 16. Acceptance Criteria

The feature is complete when:

1. Each provider independently hatches and grows its own named pet.
2. Provider switching never transfers, resets, or removes pet XP.
3. Analytics retention cannot regress collection progression.
4. Exactly one active companion is shown in primary UI surfaces.
5. Follow-provider and pinned modes persist and behave predictably.
6. Every pair of Sprout pets unlocks a permanent two-direction crossbreed.
7. Mixie unlocks only after all five pets reach Sprout and reflects the weakest shared stage.
8. All supplied sprite poses render with safe fallbacks for missing assets.
9. Celebrations occur once, obey settings, and batch noisy simultaneous unlocks.
10. Existing token totals, provider breakdowns, local-share calculations, exports, and privacy behavior remain correct.
11. The extension cleans up all animation timers and signals on hide, destroy, and disable.
12. User documentation and the sprite checklist match the shipped behavior.

## 17. Main Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Existing users lose or regress progress | Deterministic version 2 migration plus permanent collection XP outside prunable days |
| One response grants XP twice | Reuse existing event-ID deduplication before analytics and collection mutation |
| Shell performance suffers from many animations | Animate only the visible main companion; use static thumbnails elsewhere |
| GLib timers survive destroyed actors | Centralize timer ownership and remove sources on hide/destroy/disable |
| Accent placement looks wrong across silhouettes | Maintain baby/adult anchor maps and visually test every directional pair |
| Missing assets break the panel | Validate paths and use pose, idle, egg, then text fallbacks |
| Migration triggers many old celebrations | Pre-mark migrated stages and unlocks as acknowledged |
| Pet rules drift from documentation | Keep thresholds and metadata centralized in `petCollection.js` and update docs in the final phase |

## 18. Implementation Order Summary

```text
Permanent collection data
    -> migration and state tests
    -> provider egg/baby/adult renderer
    -> collection and active selection UI
    -> hatch/stage celebrations and poses
    -> crossbreed unlocks and accent overlays
    -> Mixie unlock and shared progression
    -> documentation and full shell validation
```

Each phase should leave the extension usable and retain the text-face fallback until sprite rendering and migration have both been verified in a live GNOME Shell session.