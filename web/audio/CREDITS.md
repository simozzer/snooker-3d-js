# Applause samples

Vendored so the app stays network-independent (no CDN/asset fetches). All files are
CC0 / public domain — free to redistribute in this MIT-licensed repo with no attribution
required. Credits are kept here anyway, as a courtesy.

| File | Source | Author | License |
|------|--------|--------|---------|
| `applause-1.wav` | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:277021_sandermotions_applause-2.wav) (orig. Freesound #277021) | Sandermotions | CC0 1.0 — Public Domain Dedication |
| `applause-2.oga` | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Clapping_hurray_(cropped).oga) | Starlite | Public domain |

`sound.js` loads these on the first user gesture, decodes them once, and plays randomly
picked / detuned / windowed slices layered per shot so the applause varies. If the files
are missing (or fail to decode) it falls back to the built-in synthesised applause, so the
app still works without them.
