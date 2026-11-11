# French Literature Topic Atlas

Interactive 3D map of the topics found by BERTopic in French literature, one model per decade.
Each point is a text chunk; the 20 largest topics of each decade are colored and labelled.

A static page with no build step: copy this folder into the site and it works.

```
index.html    page markup
atlas.css     styles (light and dark theme)
atlas.js      Three.js scene, decade switcher, legend, hover tooltips
data/         manifest.js + one <decade>.js per decade (~27 MB in total)
```

Three.js 0.147 (pre-built files) comes from cdn.jsdelivr.net, and the fonts from Google Fonts.

## Preview locally

```
cd topic_atlas
python3 -m http.server 8000      # then open http://localhost:8000
```

Opening `index.html` straight from disk also works.

## Publish on GitHub Pages

1. Put the folder in the site repo, e.g. as `atlas/`.
2. In the repo settings, go to Pages and choose "Deploy from a branch" (or the site's existing workflow).
3. The atlas is served at `https://<user>.github.io/<repo>/atlas/`.

All paths are relative, so the folder works under any sub-path.
If the site uses Jekyll, nothing needs configuring: no file name here starts with `_`.

## Use it as a tab of the project page

Embed it in an iframe so its 3D view, styles and mouse handling stay separate from the rest of the site:

```html
<iframe src="atlas/?embed#1961-1970" title="Topic atlas"
        style="width:100%; height:85vh; border:0" loading="lazy"></iframe>
```

- `?embed` hides the atlas title, since the host page has its own.
- `#<decade>` picks the decade to open first, e.g. `#1920-1930`. Changing the hash later switches decade.
  Without a hash the atlas opens on 1961-1970.
- `loading="lazy"` means the iframe only starts loading when the tab is shown. If the tab is hidden with
  `display:none`, set the iframe's `src` when the tab is first opened instead, so the visitor doesn't
  download 2-4 MB of data for a tab they never open.

You can also link to `atlas/` as a full page instead.

## Updating the data

The data files are created by `export_3d.py` in the thesis repo, next to the BERTopic models
(`plot_per_tesi/datamap_topics/`):

```
python export_3d.py --data data-20261110T201631Z-1-001/data --out <site repo>/atlas/data
```

`--top N` changes how many topics are colored (default 20).

Each `data/<decade>.js` holds:
- the topics: id, label, top 10 words, size, color, 3D centroid;
- per document: its 3D position (int16, base64), the index of its topic in that list (-1 for another
  topic or an outlier), and its first ~150 characters, shown on hover.

They are plain scripts, `(window.TOPIC_ATLAS = ...)["1961-1970"] = {...};`, not JSON, so the page also
works from disk. Over HTTP, `atlas.js` fetches them and parses the object.
