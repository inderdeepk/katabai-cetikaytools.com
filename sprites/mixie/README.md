# sprites/mixie/

Placeholder for the original "Mixie" collection-reward pet. The current pet system ships five
provider pets only; nothing in `src/pets/` references this directory, so the sprites are **not
required at runtime**.

The asset list from the original design is preserved in
[`Documentation/Archive/PET_SPRITE_CHECKLIST.md`](../../Documentation/Archive/PET_SPRITE_CHECKLIST.md):

```
mixie_adult_idle_01.png  mixie_adult_idle_02.png  mixie_adult_sleep.png
mixie_adult_celebrate.png  mixie_adult_tip.png
mixie_baby_idle_01.png   mixie_baby_idle_02.png   mixie_baby_sleep.png
mixie_baby_tip.png
```

`sprites/eggs/egg_mixie.png` already exists. If Mixie is reinstated, add a `PET_DEFINITIONS` entry
plus `parsePetForm()` support; see the Development Guide's "Adding a New Pet" steps.
