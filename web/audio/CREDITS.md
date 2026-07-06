# Applause samples

Vendored so the app stays network-independent (no CDN/asset fetches). **Every file is CC0 or
public domain** — free to redistribute in this MIT-licensed repo with no attribution required.
Credits are kept here anyway, as a courtesy. All sourced from Wikimedia Commons.

| File | Source | Author | License |
|------|--------|--------|---------|
| `applause-1.wav` | [Commons](https://commons.wikimedia.org/wiki/File:277021_sandermotions_applause-2.wav) (orig. Freesound #277021) | Sandermotions | CC0 1.0 |
| `applause-2.oga` | [Commons](https://commons.wikimedia.org/wiki/File:Clapping_hurray_(cropped).oga) | Starlite | Public domain |
| `applause-3.ogg` | [Commons](https://commons.wikimedia.org/wiki/File:Slow_starting_applause.ogg) | Stephan | Public domain |
| `applause-4.ogg` | [Commons](https://commons.wikimedia.org/wiki/File:Applause_i.ogg) | (Commons uploader) | Public domain |
| `applause-5.ogg` | [Commons](https://commons.wikimedia.org/wiki/File:Applause_ii.ogg) | (Commons uploader) | Public domain |
| `applause-6.ogg` | [Commons](https://commons.wikimedia.org/wiki/File:Sound_Effects_-_Applause_after_a_concert.ogg) | (Commons uploader) | CC0 1.0 |
| `applause-7.mp3` | [Commons](https://commons.wikimedia.org/wiki/File:619016_mrrap4food_clapping-then-leaving.mp3) (orig. Freesound #619016) | mrrap4food | CC0 1.0 |

`sound.js` loads these on the first user gesture, decodes them once, normalises each clip's
level, and builds each cheer from many randomly picked / detuned / windowed slices ("grains")
layered together — so with seven different crowds the applause varies a lot shot to shot. If the
files are missing (or fail to decode) it falls back to the built-in synthesised applause, so the
app still works without them.
