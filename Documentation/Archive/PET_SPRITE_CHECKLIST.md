# 🐾 Katab AI — Pet Sprite Checklist

> **Total: 60 core sprites + 5 optional UI icons** · **Format: PNG, transparent background**  
> **Baby stage: 64×64 px** · **Adult stage: 128×128 px** (baby bakes down, adult is native)  
> **Eggs: 64×64 px** · **Accents: 32×32 px**  
> 2px margin inside canvas on all sides.
>
> Runtime architecture and delivery phases: [PET_COLLECTION_IMPLEMENTATION_PLAN.md](PET_COLLECTION_IMPLEMENTATION_PLAN.md)

---

## How to use this sheet

Each row has a **copy-paste prompt** you can send to your artist verbatim.  
Check ✅ as each sprite is delivered. Statuses: ⬜ = not started · 🔄 = in progress · ✅ = done · 🔁 = needs revision

---

## COLOR PALETTES (quick reference)

| Species | Primary | Secondary | Eye | Accent |
|---|---|---|---|---|
| **Ollie** (Ollama) | `#8B6914` chestnut | `#5C7A3E` moss green | `#E8A317` amber | Cream belly |
| **Slothy** (Unsloth) | `#A0886C` taupe | `#F5E6D3` cream | `#4A3728` dark | `#D4A853` gold |
| **Sparky** (OpenAI) | `#00D4FF` cyan | `#F0F8FF` arctic white | `#0080FF` electric | `#7EB8DA` silver |
| **Clyde** (Anthropic) | `#5DADB8` teal | `#B4BEFE` lavender | `#7B68AE` violet | `#F4A8A8` coral |
| **Pearl** (DeepSeek) | `#9B59B6` amethyst | `#3498DB` crystal blue | `#1A5276` sapphire | `#FEFEFE` pearl |
| **Mixie** (Collection) | All 5 patched | Golden seams | `#E8A317` warm | — |

---

## SPECIES QUICK REFERENCE

| # | Species | Provider | Base Animal | Key Trait |
|---|---|---|---|---|
| 1 | **Ollie** | Ollama | Owl + bear cub | Acorn charm on ear, moss mantle |
| 2 | **Slothy** | Unsloth | Three-toed sloth | Tool belt, hangs upside-down |
| 3 | **Sparky** | OpenAI | Fennec fox + tiny dragon | Lightning-bolt tail tip, dragon wings |
| 4 | **Clyde** | Anthropic | Axolotl + water dragon | 6 gill fronds, pearl orb in tail |
| 5 | **Pearl** | DeepSeek | Magpie + crystal phoenix | Crystal tail feathers, geode pendant |
| 6 | **Mixie** | All-five reward | Chimera (all 5) | Patchwork body, golden seams |

---

## POSES REFERENCE (what each pose means)

| Pose | Frames | Use Case |
|---|---|---|
| `idle_01` / `idle_02` | 2-frame cycle at 800ms | Default standing/sitting, gentle breathing |
| `sleep` | 1 frame | AFK / idle timeout (>30s no activity) |
| `tip` | 1 frame | User sends message, pet "helps" |
| `celebrate` | 1 frame | Milestone reached (stage-up, achievement) |

---

---

# PART 1 — EGGS (6 sprites)

All eggs 64×64 px, resting on a simple subtle shadow (dark ellipse at base).

| # | Filename | Status | Copy-paste prompt for artist |
|---|---|---|---|
| 1 | `egg_ollie.png` | ✅ | **Ollie's Egg — The Mossy Acorn Egg.** Oval shape wider at bottom like an acorn. Bark-textured shell in warm chestnut brown (`#8B6914`) with irregular patches of soft moss green (`#5C7A3E`). Tiny cream speckles scattered on the brown areas. A single small oak leaf is stuck to the shell near the top. Hairline cracks glow with faint amber light (`#E8A317`). The top has a small cap-like ridge like an acorn's cupule. Soft inner glow visible through cracks. 64×64 px, transparent bg. |
| 2 | `egg_slothy.png` | ✅ | **Slothy's Egg — The Woven Nest Egg.** Round, almost perfectly spherical. Surface looks wrapped in woven fibers — cross-hatched line texture in warm taupe (`#A0886C`) with cream fiber lines (`#F5E6D3`). A single golden thread (`#D4A853`) wraps around the egg diagonally like a ribbon. One tiny gear/cog shape embedded in the weave near the top. Matte finish — no glow, just warm ambient shading. 64×64 px, transparent bg. |
| 3 | `egg_sparky.png` | ✅ | **Sparky's Egg — The Crackling Storm Egg.** Slightly elongated teardrop shape, pointy at top. Glassy/metallic surface in deep indigo (`#1A1A4E`). Lichtenberg figure crackle patterns in electric cyan (`#00D4FF`) branching across the surface. Small white-hot sparks at crack intersections. Shell is semi-translucent — a bright glowing core visible inside. The whole egg pulses with light. 64×64 px, transparent bg. |
| 4 | `egg_clyde.png` | ✅ | **Clyde's Egg — The Pearl Tear Egg.** Smooth teardrop shape, rounded bottom. Silky polished surface like sea glass in pale seafoam green (`#B2DFDB`) with subtle lavender iridescence (`#B4BEFE`) — colorshift visible as a soft gradient. Coral-pink blush (`#F4A8A8`) near the bottom tip. Six tiny dots (future gill spots) mark the sides, three per side. A single small water droplet clings to the bottom tip. Gentle diffused inner light. 64×64 px, transparent bg. |
| 5 | `egg_pearl.png` | ✅ | **Pearl's Egg — The Geode Egg.** Asymmetric rough-hewn rock shape in dark amethyst (`#6C3483`) with natural darker-purple striations. A large crack at the top reveals a hollow interior lined with tiny crystal points in brilliant crystal blue (`#3498DB`) and white crystalline edges (`#FEFEFE`). Faceted crystal growths jut outward from the crack. The dark rough exterior contrasts sharply with the bright sparkly interior. Light refracts inside. 64×64 px, transparent bg. |
| 6 | `egg_mixie.png` | ✅ | **Mixie's Egg — The Patchwork Puzzle Egg.** Round but slightly lumpy shape. Shell divided into 5 visible sections by golden seams (`#E8A317` glow). Each section has a different egg texture: one mossy brown acorn patch, one woven taupe patch, one crackling indigo patch, one pearlescent seafoam patch, one crystalline amethyst patch. Golden thread stitches the patches together along visible seams that glow warmly. Adorably mismatched and unique-looking. 64×64 px, transparent bg. |

---

# PART 2 — OLLIE (Owl-Bear) · 9 sprites

> **Silhouette**: Round stout body, large round owl eyes, small bear ears, tiny clawed paws.  
> **Key trait**: Acorn charm on left ear → pinecone on vine at adult. Oak leaf on head → full moss mantle at adult.

| # | Filename | Status | Copy-paste prompt for artist |
|---|---|---|---|
| 7 | `ollie_baby_idle_01.png` | ✅ | **Ollie Baby Idle frame 1.** Tiny round ball of brown fluff occupying ~60% of frame. Two enormous amber eyes (`#E8A317`) take up half the body area — big cute cartoon proportions. No visible limbs, just a puffball. Two tiny ear nubs — small darker-brown triangle tufts on top. Small darker patch where a beak will eventually grow. Soft downy fluff texture. Eyes looking slightly up-right (toward imaginary chat window). 64×64 px, transparent bg. |
| 8 | `ollie_baby_idle_02.png` | ✅ | **Ollie Baby Idle frame 2.** Same as idle_01 but body settled ~2px lower (gentle exhale), eyes half-closed in a contented slow blink (eyes become happy curved arches), ear nubs droop slightly. 64×64 px, transparent bg. |
| 9 | `ollie_baby_sleep.png` | ✅ | **Ollie Baby Sleep.** Fluffball nestled down flat into a soft oval shape — like a sleepy chick. Eyes closed as two curved lines (ᵕ ᵕ shape). Tiny hand-drawn "Zzz" bubble floating above (2 Zs). One ear nub slightly twitched/tilted. Visible patch of moss green (`#5C7A3E`) on the back area. Cozy tucked-in vibe. 64×64 px, transparent bg. |
| 10 | `ollie_baby_tip.png` | ✅ | **Ollie Baby Tip.** The puffball has sprouted ONE tiny round paw (nub with two tiny dot-claws) pointing upward and to the right. Body leans slightly left to balance. Eyes wide and earnest — "look at this!" expression. Tiny floating spark icon (simple 4-point star) above the pointing paw. Eager helpful vibe. 64×64 px, transparent bg. |
| 11 | `ollie_adult_idle_01.png` | ✅ | **Ollie Adult Idle frame 1.** Full majestic owl-bear taking ~75% of frame height. Strong rounded bear body with thick fur texture. Distinct horned-owl facial disc — two concentric circles of lighter cream-brown around each amber eye. Defined small bear ears with tufts. A full crown of oak leaves and draping moss (`#5C7A3E`) over the shoulders like a nature mantle. Pinecone charm hanging from left ear on a braided vine. Small gnarled wooden staff held in one paw, topped with a tiny glowing amber crystal. Standing proudly on two hind paws, front paws visible at sides. Eyes glow faintly. 128×128 px, transparent bg. |
| 12 | `ollie_adult_idle_02.png` | ✅ | **Ollie Adult Idle frame 2.** Same as adult_idle_01 but chest expands slightly (inhale), pinecone sways gently to the left, crystal pulses with a soft glow, eyes half-lidded in a wise slow blink. Body shifts ~3px taller. 128×128 px, transparent bg. |
| 13 | `ollie_adult_sleep.png` | ✅ | **Ollie Adult Sleep.** Curled up in a circle like a sleeping cat, nestled in a simple circular bed of moss and oak leaves at the base of the frame. Horned-owl facial disc visible from side profile. Staff rests across the body. Pinecone charm tucked under chin. Deep peaceful expression with closed eyes. 4 Zs rising in a gentle curve. Crystal on staff emits soft nightlight amber glow. 128×128 px, transparent bg. |
| 14 | `ollie_adult_tip.png` | ✅ | **Ollie Adult Tip.** Standing tall on hind legs, one front paw raised pointing forward and slightly up with one claw extended. Staff planted firmly in the other paw. A semi-transparent glowing scroll of knowledge unfurls upward from the staff crystal — parchment-colored with faint rune markings. Leaf crown stands at full attention. Expression: wise and patient, like a professor mid-lecture. 128×128 px, transparent bg. |
| 15 | `ollie_adult_celebrate.png` | ✅ | **Ollie Adult Celebrate.** Both arms raised high, staff held aloft — the crystal bursts with brilliant amber light rays radiating outward. Oak leaves float up around the body. Pinecone swings wildly outward. Mouth open in a triumphant open-beak hoot. Sparkle stars (simple 4-point) and small leaf particles fill the upper third of frame. Most energetic pose — pure joy. 128×128 px, transparent bg. |

---

# PART 3 — SLOTHY (Sloth Artisan) · 9 sprites

> **Silhouette**: Long arms, curved claws, round gentle face with dark eye-mask marking.  
> **Key trait**: Hangs upside-down from invisible top-of-frame branch. Tiny tool belt at adult.

| # | Filename | Status | Copy-paste prompt for artist |
|---|---|---|---|
| 16 | `slothy_baby_idle_01.png` | ✅ | **Slothy Baby Idle frame 1.** Tiny baby sloth hanging upside-down from an invisible anchor at the top of the frame. Round ball of taupe fluff (`#A0886C`) with cream belly showing (`#F5E6D3`). Two tiny arms hanging down with small single-claw nubs. No eye mask yet — just two dark brown dot eyes (`#4A3728`). Head is round and simple. Occupies ~50% of frame height, hanging from top. 64×64 px, transparent bg. |
| 17 | `slothy_baby_idle_02.png` | ✅ | **Slothy Baby Idle frame 2.** Same but body sways ~3px to the left (gentle pendulum), arms trail slightly behind. Eyes half-close in the world's slowest blink — eyelids just barely lowered. The vibe is "so slow it's cute." 64×64 px, transparent bg. |
| 18 | `slothy_baby_sleep.png` | ✅ | **Slothy Baby Sleep.** Hanging completely limp from top anchor — all four tiny limbs dangling straight down like a ragdoll. Eyes closed as two tiny curved lines. Tiny "Zzz" (2 Zs, hand-drawn) drifting sideways (not up, because he's upside-down). Cream belly fully exposed. Peaceful, dead-asleep hanging. 64×64 px, transparent bg. |
| 19 | `slothy_baby_tip.png` | ✅ | **Slothy Baby Tip.** Still hanging upside-down. One long arm extends downward, single claw pointing toward bottom-right. Head tilted slightly to watch where he's pointing. Eyes wide and earnest. A tiny floating spark or lightbulb near the claw tip. "Look down there!" energy. 64×64 px, transparent bg. |
| 20 | `slothy_adult_idle_01.png` | ✅ | **Slothy Adult Idle frame 1.** Full adult sloth hanging upside-down, filling ~70% of frame height. Defined dark eye-mask marking (`#4A3728`) around both eyes — classic three-toed sloth face. Cream face within the mask. Three distinct curved claws on each paw (`#D4A853` muted gold). Small tool belt strapped diagonally across the body — visible tiny wrench and hammer shapes. Gentle knowing smile. Long fur texture with subtle tufts at elbows. 128×128 px, transparent bg. |
| 21 | `slothy_adult_idle_02.png` | ✅ | **Slothy Adult Idle frame 2.** Same but body sways ~4px to the right. One claw curls slightly. Eyes in ultra-slow blink — eyelids at ~60% closed. Tool belt tools shift slightly with the sway. 128×128 px, transparent bg. |
| 22 | `slothy_adult_sleep.png` | ✅ | **Slothy Adult Sleep.** Hanging completely limp, all four limbs dangling. Tool belt unbuckled and hanging from a separate tiny hook (or draped over one arm). Eye mask still visible but eyes closed. 4 Zs drifting sideways in a gentle curve. Claws relaxed and slightly curled inward. Deep sleep. 128×128 px, transparent bg. |
| 23 | `slothy_adult_tip.png` | ✅ | **Slothy Adult Tip.** One arm extends fully downward, three claws pointing precisely at bottom-right corner. Head rotated to look along the arm. Other arm holds a tiny pair of artisan goggles pushed up onto the forehead. Tool belt prominent. Expression is patient instructor — "here's exactly how you do it." A tiny floating diagram/schematic icon near the pointing claws. 128×128 px, transparent bg. |
| 24 | `slothy_adult_celebrate.png` | ✅ | **Slothy Adult Celebrate.** The least energetic celebration — both arms raised upward (toward bottom of frame since he's upside-down) in a slow-motion "yay!" A tiny banner unfurls between the raised claws reading nothing — just a decorative pennant. Eyes are happy arches. Tool belt tools jingle — small motion lines near the wrench. Mouth is a tiny happy curve. 128×128 px, transparent bg. |

---

# PART 4 — SPARKY (Storm Fox-Dragon) · 9 sprites

> **Silhouette**: Sleek pointed fox body, huge triangular ears, long flowing tail with lightning-bolt tip. Small dragon wings at adult.  
> **Key trait**: Always slightly hovering — feet don't touch the ground. Electric aura.

| # | Filename | Status | Copy-paste prompt for artist |
|---|---|---|---|
| 25 | `sparky_baby_idle_01.png` | ✅ | **Sparky Baby Idle frame 1.** A tiny living electric ember — basically a bright glowing teardrop/blob in electric cyan (`#00D4FF`) with a white-hot core. Two huge bright blue dot eyes (`#0080FF`). No limbs yet, just a blob. Faint electric arc wisps curling off the top. Hovers ~4px above the baseline. Occupies ~40% of frame — it's very small, like a blueberry. 64×64 px, transparent bg. |
| 26 | `sparky_baby_idle_02.png` | ✅ | **Sparky Baby Idle frame 2.** Same ember but pulses slightly larger (scale ~110%), the electric wisps extend further, and the core brightens. Eyes widen slightly. Creates a subtle "breathing glow" when cycled. 64×64 px, transparent bg. |
| 27 | `sparky_baby_sleep.png` | ✅ | **Sparky Baby Sleep.** The ember has dimmed to a soft glow. It's settled onto the "ground" (touching the baseline — only time it does). Shape is slightly flattened oval. Eyes closed as tiny cyan curved lines. Faint pulsing glow at ~30% brightness. Tiny "Zzz" in white. Looks like a dormant spark. 64×64 px, transparent bg. |
| 28 | `sparky_baby_tip.png` | ✅ | **Sparky Baby Tip.** The ember has sprouted ONE tiny wing nub that points to the upper right. Body stretches slightly toward that direction. Eyes wide and bright. A tiny electric arc jumps from the pointing wing tip. "That way!" energy. 64×64 px, transparent bg. |
| 29 | `sparky_adult_idle_01.png` | ✅ | **Sparky Adult Idle frame 1.** Sleek fennec-fox-dragon hybrid filling ~70% of frame. Large triangular fox ears (`#F0F8FF` arctic white inside, cyan outside). Sleek pointed face with bright electric blue eyes (`#0080FF`) that glow. Small dragon wings sprouting from back — membrane in silver-blue (`#7EB8DA`). Long flowing tail curling behind, ending in a distinct lightning-bolt-shaped tip (`#00D4FF` glowing). Body is arctic white with cyan markings along the spine. Hovers ~8px above baseline — paws never touch down. Faint crackling electric aura around the body (subtle, not overpowering). 128×128 px, transparent bg. |
| 30 | `sparky_adult_idle_02.png` | ✅ | **Sparky Adult Idle frame 2.** Same but hovers ~2px higher, wings give one subtle flap (slightly spread wider), tail bolt flashes brighter, ears perk up more. Electric aura crackles with one or two visible tiny arcs. 128×128 px, transparent bg. |
| 31 | `sparky_adult_sleep.png` | ✅ | **Sparky Adult Sleep.** Curled into a floating ball — tail wraps completely around the body with the lightning-bolt tip resting near the nose. Wings folded tight against the body. Dimmed glow — body is soft silver-blue instead of bright cyan. Eyes closed. Gentle pulsing light at ~20% brightness. 4 Zzs in white drifting upward. Looks like a sleeping thundercloud. 128×128 px, transparent bg. |
| 32 | `sparky_adult_tip.png` | ✅ | **Sparky Adult Tip.** One wing extends fully to point right. Tail stands straight up like an exclamation mark — lightning bolt tip crackling with energy. Body leans forward dynamically. Eyes are wide and intense — "I know exactly the answer!" A small electric spark trail arcs from the wing tip to a floating lightbulb icon. 128×128 px, transparent bg. |
| 33 | `sparky_adult_celebrate.png` | ✅ | **Sparky Adult Celebrate.** Zooming in a tiny energetic circle — motion lines form a small loop trail. Both wings spread wide. Tail leaving a crackling spark trail that forms a brief circle. Mouth open in a happy yip. Electric aura at full brightness with visible arcs jumping off ears and tail. Pure zoomies energy. Sparkle stars scattered around. 128×128 px, transparent bg. |

---

# PART 5 — CLYDE (Serene River Dragon) · 9 sprites

> **Silhouette**: Smooth elongated body, external gill fronds (3 per side), flowing whiskers, serpentine curves.  
> **Key trait**: Pearl orb floating near tail curl. Flowing underwater-like pose.

| # | Filename | Status | Copy-paste prompt for artist |
|---|---|---|---|
| 34 | `clyde_baby_idle_01.png` | ✅ | **Clyde Baby Idle frame 1.** Tiny tadpole-like creature. Simple round head-body in soft teal (`#5DADB8`) with a small tail fin (translucent teal with subtle lavender edge `#B4BEFE`). Two tiny gill bud nubs on each side of head — small coral-pink bumps (`#F4A8A8`). Two tiny dot eyes in deep violet (`#7B68AE`). No limbs yet. Occupies ~45% of frame, floating as if in water. Curved gentle C-shape body posture. 64×64 px, transparent bg. |
| 35 | `clyde_baby_idle_02.png` | ✅ | **Clyde Baby Idle frame 2.** Same but tail fin waves gently to one side (~10°), gill buds pulse slightly larger (just a pixel or two), body drifts ~2px upward. Eyes half-blink in a slow, serene way. 64×64 px, transparent bg. |
| 36 | `clyde_baby_sleep.png` | ✅ | **Clyde Baby Sleep.** Curled into a tiny spiral — tail wraps around the body. Gill buds are dimmed and relaxed. Eyes closed as two tiny violet curves. Tiny "Zzz" (2 Zs) drifting upward with a slight wavy path (like bubbles in water). Soft dim glow. Settled at the bottom of the frame. 64×64 px, transparent bg. |
| 37 | `clyde_baby_tip.png` | ✅ | **Clyde Baby Tip.** Body forms a gentle S-curve. Head raised upward, one tiny gill bud extended slightly more than the others — pointing right. Eyes are wide and earnest. A tiny floating droplet icon near the extended gill. "Let me show you..." energy. 64×64 px, transparent bg. |
| 38 | `clyde_adult_idle_01.png` | ✅ | **Clyde Adult Idle frame 1.** Serene river dragon filling ~65% of frame. Smooth elongated body in soft teal (`#5DADB8`) with lavender underbelly (`#B4BEFE`). Six full feathery external gill fronds — three per side — coral pink (`#F4A8A8`) with feathery branching tips that look like underwater plants gently swaying. Two flowing whiskers (like an Asian dragon) curling gracefully from the snout. Four small legs with delicate webbed feet. Tail curls in a spiral, holding a glowing pearl orb (`#FEFEFE` with soft lavender inner glow). Deep violet eyes (`#7B68AE`) with a gentle expression. Body posture is a relaxed horizontal S-curve, floating. 128×128 px, transparent bg. |
| 39 | `clyde_adult_idle_02.png` | ✅ | **Clyde Adult Idle frame 2.** Same but gill fronds sway ~8px to the right (wave motion), whiskers drift slightly, pearl orb pulses with a soft brightness increase (~20%). Body drifts ~3px upward. Eyes do a slow serene blink — eyelids at 50%. 128×128 px, transparent bg. |
| 40 | `clyde_adult_sleep.png` | ✅ | **Clyde Adult Sleep.** Curled into a peaceful spiral, tail wrapping around with the pearl orb resting at the center like a nightlight (soft steady glow). Gill fronds draped gently over the body like a blanket. Whiskers relaxed and hanging down. Eyes closed peacefully. 4 Zzs drifting upward in a gentle bubble-like wavy path. Settled at frame bottom. 128×128 px, transparent bg. |
| 41 | `clyde_adult_tip.png` | ✅ | **Clyde Adult Tip.** One whisker extends and curls to point toward the upper right. Body forms an elegant question-mark-like curve. Pearl orb floats up near the head, glowing brighter. Gill fronds flare slightly outward. Expression is gentle and wise — "I've thought about this carefully, here's what I think." A tiny floating scroll or document icon near the whisker tip. 128×128 px, transparent bg. |
| 42 | `clyde_adult_celebrate.png` | ✅ | **Clyde Adult Celebrate.** Leaping upward in a joyful arc like a dolphin breaching — body forms a crescent curve. Pearl orb shoots upward trailing sparkles. Gill fronds flare out fully like celebratory streamers. Whiskers curl upward in happy spirals. Small water-droplet particles scattered around. Mouth is a happy open curve. Pure serene joy — not frantic, just beautiful. 128×128 px, transparent bg. |

---

# PART 6 — PEARL (Crystal Magpie-Phoenix) · 9 sprites

> **Silhouette**: Elegant bird-like body, sharp intelligent beak, crested head, crystalline tail feathers.  
> **Key trait**: Geode pendant. Tail feathers are literal crystal shards that refract light. Perches like a bird.

| # | Filename | Status | Copy-paste prompt for artist |
|---|---|---|---|
| 43 | `pearl_baby_idle_01.png` | ✅ | **Pearl Baby Idle frame 1.** A tiny geode fragment that has cracked open — a small crystalline chick emerging. Round amethyst body (`#9B59B6`) with a stubby tiny beak in pearl white (`#FEFEFE`). One single tiny crystal shard tail feather (`#3498DB` crystal blue) pointing down. Two tiny sapphire-blue dot eyes (`#1A5276`). Occupies ~45% of frame. Sits on the "ground" like a baby bird in a nest. Faceted but soft — cute baby crystal. 64×64 px, transparent bg. |
| 44 | `pearl_baby_idle_02.png` | ✅ | **Pearl Baby Idle frame 2.** Same but the tail crystal catches light and glints (a small white sparkle on the facet edge). Body bobs ~2px upward. Eyes blink — a quick faceted glint across them. Beak opens in a tiny silent chirp. 64×64 px, transparent bg. |
| 45 | `pearl_baby_sleep.png` | ✅ | **Pearl Baby Sleep.** Head tucked under a tiny wing nub. Body is a round amethyst puffball. Tail crystal dimmed to a soft glow. Eyes closed. Tiny "Zzz" in white. Geode shell fragments (two small dark-purple shards) rest beside the chick — it hatched from these. Settled at frame bottom. 64×64 px, transparent bg. |
| 46 | `pearl_baby_tip.png` | ✅ | **Pearl Baby Tip.** Standing on tiny clawed feet (`#FEFEFE` pearl). One wing nub extended to point right. Tail crystal stands straight up with a bright glint. Eyes wide and sparkling — "I found something!" A tiny floating gem icon near the wing tip. 64×64 px, transparent bg. |
| 47 | `pearl_adult_idle_01.png` | ✅ | **Pearl Adult Idle frame 1.** Radiant crystal phoenix-magpie filling ~70% of frame. Elegant bird body in deep amethyst (`#9B59B6`) with iridescent wing feathers that shift from purple to blue to pearl white depending on the feather. Sharp intelligent magpie beak in pearl white. Crested head — three crystal feathers sweeping back. Seven crystal tail feathers fanned out behind — each a faceted shard in crystal blue (`#3498DB`) with white edge highlights. Tiny geode pendant (a small amethyst geode slice) hanging from a silver chain around the neck. Sapphire eyes (`#1A5276`) with a knowing sparkle. Perched on invisible branch — claws wrapped around it. 128×128 px, transparent bg. |
| 48 | `pearl_adult_idle_02.png` | ✅ | **Pearl Adult Idle frame 2.** Same but tail crystals fan slightly wider (~5°), light refracts across the facets producing a subtle prismatic gleam (a small rainbow-white highlight moves across the tail). Body bobs ~3px as if adjusting perch. Eyes half-lid in a wise knowing blink. Geode pendant catches light. 128×128 px, transparent bg. |
| 49 | `pearl_adult_sleep.png` | ✅ | **Pearl Adult Sleep.** Head tucked under one wing — classic bird sleep pose. Tail crystals fold down and inward like a peacock's train at rest, dimmed to a soft glow. Geode pendant rests against the perch. Body is a peaceful rounded amethyst shape. 4 Zzs rising in a gentle curve. Soft crystal nightlight glow. 128×128 px, transparent bg. |
| 50 | `pearl_adult_tip.png` | ✅ | **Pearl Adult Tip.** One wing extends gracefully to point right. The longest central tail crystal angles forward over the body, its tip pointing in the same direction — a beam of prismatic light shines from the crystal tip to a floating gem/idea icon. Head is raised with a knowing, precise expression. Geode pendant swings forward with the motion. "I see exactly what you need." 128×128 px, transparent bg. |
| 51 | `pearl_adult_celebrate.png` | ✅ | **Pearl Adult Celebrate.** Wings spread wide and high. All seven tail crystals fan out in full magnificent display — each one refracting light in a different color of the rainbow. Prismatic light rays burst outward from the body. Beak open in a triumphant call. Sparkle particles and tiny floating crystal shards fill the upper frame. The geode pendant glows brilliantly. Most spectacular pose of all creatures. 128×128 px, transparent bg. |

---

# PART 7 — MIXIE (Chimera) · 4 body sprites + egg

> Mixie is the all-five collection reward. Its four body sprites provide two-frame baby and adult idle animations; its egg is in Part 1.  
> **Design**: Patchwork creature combining elements from all 5 species with golden seam lines.

| # | Filename | Status | Copy-paste prompt for artist |
|---|---|---|---|
| 52 | `mixie_baby_idle_01.png` | ⬜ | **Mixie Baby Idle.** A tiny round patchwork puffball. The round owl-like body (Ollie base shape) is divided into 5 visible patches by glowing golden seam lines (`#E8A317`). Patches: one mossy brown fur patch (Ollie), one woven-taupe patch with cross-hatch texture (Slothy), one electric cyan patch with tiny crackle marks (Sparky), one soft teal patch with a tiny coral dot (Clyde), one crystalline amethyst patch with a facet highlight (Pearl). Two mismatched eyes: one amber (Ollie), one electric blue (Sparky). Tiny sloth-like arm nubs hang from the sides. Golden seams pulse with a warm glow. Cute, chaotic, unique. 64×64 px, transparent bg. |
| 53 | `mixie_baby_idle_02.png` | ⬜ | **Mixie Baby Idle frame 2.** Same but the body gently bounces ~2px, the patches shift slightly (like a patchwork quilt breathing), golden seams brighten briefly, mismatched eyes blink at slightly different times (one then the other — adorably uncoordinated). 64×64 px, transparent bg. |
| 54 | `mixie_adult_idle_01.png` | ⬜ | **Mixie Adult Idle.** Full patchwork chimera creature, ~70% of frame. Combines: Ollie's round bear body shape with Slothy's long arms (hanging from sides), Sparky's fox ears (one on each side, slightly different sizes), Clyde's gill fronds (3 coral-pink fronds on the left side of the neck), Pearl's crystal tail feather (one larger shard tail emerging from the back). The body is visibly stitched from 5 different textured patches with golden glowing seams. One amber eye, one electric blue eye. Slothy's tiny tool belt across the waist. Ollie's oak leaf perched on one ear. A small pearl orb floats near the tail. Chaotic but harmonious — the "everything bagel" of pets. 128×128 px, transparent bg. |
| 55 | `mixie_adult_idle_02.png` | ⬜ | **Mixie Adult Idle frame 2.** Same but patches ripple gently (like a patchwork flag in breeze), golden seams pulse, gill fronds sway left, ears twitch (one then the other at different times), mismatched eyes blink asynchronously. The tail crystal glints. The pearl orb orbits slightly. Delightfully uncoordinated but rhythmic. 128×128 px, transparent bg. |

---

# PART 8 — CROSSBREED ACCENT OVERLAYS · 5 sprites

> **32×32 px each.** These are small accessory sprites layered ON TOP of the base species sprite when that species is the accent provider in a crossbreed.

| # | Filename | Status | Copy-paste prompt for artist |
|---|---|---|---|
| 56 | `accent_ollie.png` | ⬜ | **Ollie Crossbreed Accent.** A tiny cluster of 1 oak leaf (`#5C7A3E` moss green) + 1 small acorn (`#8B6914` chestnut brown) tied together with a tiny vine. Simple, readable at small size. This appears on the non-Ollie base pet when Ollama is the secondary provider — e.g., a Sparky body with this little oak-and-acorn pinned to an ear or wing. 32×32 px, transparent bg. |
| 57 | `accent_slothy.png` | ⬜ | **Slothy Crossbreed Accent.** A single tiny golden wrench (`#D4A853` muted gold) — simple tool silhouette. Readable at small size. Appears on the non-Slothy base pet when Unsloth is secondary — e.g., a Clyde body with this little wrench tucked into a gill frond. 32×32 px, transparent bg. |
| 58 | `accent_sparky.png` | ⬜ | **Sparky Crossbreed Accent.** A tiny lightning bolt (`#00D4FF` electric cyan, with white-hot core). Simple jagged bolt shape. Readable at small size. Appears on the non-Sparky base pet when OpenAI is secondary — e.g., a Pearl body with this bolt marking on the wing. 32×32 px, transparent bg. |
| 59 | `accent_clyde.png` | ⬜ | **Clyde Crossbreed Accent.** A tiny pearl orb (`#FEFEFE` pearl white with soft lavender `#B4BEFE` inner glow). Simple circle with a soft radial gradient and one small specular highlight. Appears on the non-Clyde base pet when Anthropic is secondary. 32×32 px, transparent bg. |
| 60 | `accent_pearl.png` | ⬜ | **Pearl Crossbreed Accent.** A tiny crystal shard (`#3498DB` crystal blue with white edge highlight). Simple elongated diamond/quartz shape with one facet line. Readable at small size. Appears on the non-Pearl base pet when DeepSeek is secondary — e.g., an Ollie body with this little crystal on the staff or ear. 32×32 px, transparent bg. |

---

# PART 9 — UI ICONS (optional bonus) · 5 sprites

> **24×24 px each.** Small UI accent icons for stage badges, mood indicators, etc. These are lower priority — start with sprites 1–60 above.

| # | Filename | Status | Copy-paste prompt for artist |
|---|---|---|---|
| 61 | `ui_stage_egg.png` | ⬜ | Small egg icon for stage badge. Simple oval egg shape in neutral warm gray with a tiny sparkle highlight. 24×24 px, transparent bg. |
| 62 | `ui_stage_hatchling.png` | ⬜ | Small cracked egg icon — egg shape with a small crack and a tiny paw/wing poking out. 24×24 px, transparent bg. |
| 63 | `ui_stage_scholar.png` | ⬜ | Small graduation cap or open book icon with a tiny sparkle. 24×24 px, transparent bg. |
| 64 | `ui_stage_sage.png` | ⬜ | Small crystal/star burst icon — 4-point radiant star with soft glow. 24×24 px, transparent bg. |
| 65 | `ui_paw_cursor.png` | ⬜ | Tiny paw-print cursor replacement for hovering over the pet. Simple rounded paw shape with three toe beans. 24×24 px, transparent bg. |

---

# SUMMARY TABLE

| Part | Sprites | Status |
|---|---|---|
| Part 1 — Eggs | #1–6 (6) | ✅ |
| Part 2 — Ollie | #7–15 (9) | ✅ |
| Part 3 — Slothy | #16–24 (9) | ✅ |
| Part 4 — Sparky | #25–33 (9) | ✅ |
| Part 5 — Clyde | #34–42 (9) | ✅ |
| Part 6 — Pearl | #43–51 (9) | ✅ |
| Part 7 — Mixie | #52–55 (4) + egg #6 | Egg ✅ · bodies ⬜ |
| Part 8 — Accents | #56–60 (5) | ⬜ |
| Part 9 — UI Icons | #61–65 (5) [optional] | ⬜ |
| **TOTAL** | **65 sprites** (60 core + 5 optional) | **51/60 core delivered** |

---

## Notes for the artist

- **Line art**: Clean, slightly soft vector-style outlines (1.5–2px weight) in a color slightly darker than the fill — not pure black. For Sparky, outlines can be glowing cyan instead.
- **Shading**: Cel-shaded with 2–3 tone levels (base, shadow, highlight). Keep it simple and readable at small sizes.
- **Eyes**: The most important feature — make them expressive. Use simple shapes (circles, curves) with a single white catchlight dot.
- **Baby vs Adult**: Babies should be ~60% head, adults ~35% head. Babies are chibi proportions. Adults are more natural.
- **Deliverables**: One PNG per sprite as listed. Organize into folders: `eggs/`, `ollie/`, `slothy/`, `sparky/`, `clyde/`, `pearl/`, `mixie/`, `accents/`, `ui/`.
- **Priority order**: Eggs first → adult idles (the face of the feature) → baby idles → sleep/celebrate → tip → accents → UI.
