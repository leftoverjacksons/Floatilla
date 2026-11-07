# Crew portraits

Crew are shown as character cards (Tab in game, and on the crew strip in the HUD). Each person draws a
portrait id from `PORTRAITS` in `src/crew.js` and keeps it for the whole voyage. Until artwork exists
the game draws a placeholder (a silhouette on a colour derived from the id, with the person's initial),
so portraits can be added one at a time.

## Files

- Location: `public/portraits/<id>.webp` (served as `portraits/<id>.webp`).
- Ids: `p01` … `p36`, plus `captain` for the player.
- Size: 512 × 640 px (4:5, portrait). The card shows them at 96 × 120 and the HUD at 30 × 38, so keep
  the face large and centred, with the eyes about 40% from the top.
- Format: WebP, quality ~80, under ~80 KB each.

## Briefs and prompts

Each entry in `PORTRAITS` is the brief for that face (age, look, clothes). To print a full prompt per
file, with the shared style line appended:

```bash
node tools/portrait_prompts.mjs
```

The shared style (edit it in `tools/portrait_prompts.mjs`) is: painted card-game portrait, head and
shoulders, three-quarter view, muted coastal palette, soft overcast light, plain dark blue-grey
background, no text or frame. All 37 images should read as one set: same background, same light
direction, same brush treatment.

## Roles and names

The portrait is independent of the person's name and role (both are rolled separately), so briefs avoid
anything that only fits one role. A brief like "nurse's scrubs under a rain jacket" is fine for anyone:
people grabbed what they were wearing.

## Adding more

Append entries to `PORTRAITS` with new ids and add the matching files. Existing voyages keep their
portrait ids, so never renumber or remove entries.
