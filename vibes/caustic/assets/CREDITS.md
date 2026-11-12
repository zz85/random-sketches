# luv.glb

Not in the repository: `python3 tools/fetch_makehuman.py` downloads the MakeHuman data below (only the files it needs, from MPFB 2 on GitHub and from the community's asset packs by HTTP range reads) into `assets/.makehuman` and builds `assets/luv.glb` with `tools/makehuman_luv.py`. Each asset keeps its own licence.

| Part | Asset | Author | Licence (asset pack) | Note |
|---|---|---|---|---|
| Body, targets, game-engine rig and weights | MakeHuman base mesh via [MPFB 2](https://github.com/makehumancommunity/mpfb2) data | MakeHuman team | CC0 | |
| Eyes, eyebrows, eyelashes, braid hair | `low-poly` eyes, `eyebrow002`, `eyelashes01`, `braid01` (makehuman_system_assets) | MakeHuman team | CC0 | |
| Tunic | `wdg_mycenaean_tunic` (dress01) | WDG | CC0 | the .mhclo header says AGPL3 |
| Winter coat | `punkduck_winter_coat` (dress03) | punkduck | CC-BY | header: CC BY 3.0 |
| Long hair | `o4saken_long01` (hair01) | 04saken | CC0 | header: CC BY 4.0 |
| Hair bun | `rehmanpolanski_hair_bun_brown` (hair01) | Rehman Polanski | CC0 | header: AGPL3 |
| Stiletto booties | `toigo_stiletto_booties` (shoes01) | MRT (MargaretToigo) | CC0 | |
| Skins | `darthfurby_caucasian_female`, `onlytheghosts_middle_aged_eurasian_female` (skins01) | darthfurby, OnlyTheGhosts | CC0 | |

The asset packs are at <https://static.makehumancommunity.org/assets/assetpacks/index.html>. Where a file's own header
gives another licence than its pack, the stricter one is credited here: the coat and the long hair are attributed to
their authors.
