# Applause samples

Vendored so the app stays network-independent (no CDN/asset fetches). Every file is CC0,
public domain, or CC BY — all fine to redistribute in this MIT-licensed repo. The CC BY clip
requires attribution, which this file provides; the code itself stays MIT.

| File | Source | Author | License |
|------|--------|--------|---------|
| `applause-1.wav` | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:277021_sandermotions_applause-2.wav) (orig. Freesound #277021) | Sandermotions | CC0 1.0 — Public Domain Dedication |
| `applause-2.oga` | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Clapping_hurray_(cropped).oga) | Starlite | Public domain |
| `applause-3.ogg` | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Slow_starting_applause.ogg) | Stephan | Public domain |
| `applause-4.ogg` | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Applause-2.ogg) | RHumphries | CC BY 3.0 (attribution required) |

`sound.js` loads these on the first user gesture, decodes them once, normalises each clip's
level, and builds each cheer from many randomly picked / detuned / windowed slices ("grains")
layered together — so the applause varies shot to shot. If the files are missing (or fail to
decode) it falls back to the built-in synthesised applause, so the app still works without them.
