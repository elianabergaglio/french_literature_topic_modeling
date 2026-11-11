# French Literature Topic Modeling

Code for the PhD thesis and the project website.

## Website

The site is in [`docs/`](docs/) and is served by GitHub Pages straight from the `main` branch. There is no build step.

```
docs/
  index.html         Home tab
  corpus.html        Corpus tab
  topic-atlas.html   Topic Atlas tab (embeds atlas/ in an iframe)
  assets/site.css    shared styles and the tab bar
  atlas/             the interactive 3D topic atlas (see docs/atlas/README.md)
  .nojekyll          tells GitHub Pages to serve the files as they are
```

To add a tab, copy `corpus.html`, then add the link to the `<nav class="tabs">` of every page.

A decade can be linked directly: `topic-atlas.html#1920-1930`.

### Preview locally

```
python3 -m http.server 8000 --directory docs   # then open http://localhost:8000
```

### Publish

In the GitHub repo: Settings → Pages → Source: "Deploy from a branch", Branch: `main`, folder: `/docs`.
The site is then served at [`https://elianabergaglio.github.io/french_literature_topic_modeling/`](https://elianabergaglio.github.io/french_literature_topic_modeling/).
