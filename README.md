# opencol.github.io

The OpenCol website: what OpenCol is, the download, and every release's changes.
Live at **https://opencol.github.io/**.

The site belongs to the community as much as the game does. Found a typo, a better
screenshot, a feature that deserves a card? Open a pull request — every merge to
`main` is live a minute later.

## What is where

```
src/pages/index.html    the landing page - edit this for the words on the front page
src/pages/rules.html    /rules/ - how rule options are decided
src/pages/404.html      the page for a broken link
src/layout.html         the bar and footer every page shares
assets/site.css         this site's own layout, on top of the design system
assets/vendor/col.css   the OpenCol design system (OpenCol/web-ui), vendored
assets/img/             the screenshots and the ship
site.json               links (Discord, issues, stores) and the download buttons
scripts/build.mjs       turns all of the above into _site/
```

What changes with every OpenCol release is **not** written here. The build reads
it from [OpenCol/OpenCol](https://github.com/OpenCol/OpenCol) on GitHub:

- the version, date and download buttons, from the latest release;
- `/changelog/`, from `CHANGELOG.md` on OpenCol's `main` (`site.json` >
  `changelogRef`), so a fix to it or its pictures shows without a release;
- `/changelog/<version>/`, one page per release, from its release notes;
- the map count and the six featured maps (`site.json` > `maps.featured`), from
  the public catalogue of [OpenCol/maps](https://github.com/OpenCol/maps);
- on `/rules/`, every rule option and the `OPENCOL.INI` defaults, from the
  latest release's CHANGELOG, "The rules" section.

The latest release's zips and the changelog's pictures are copied into the site
(`/download/`, `/media/`), so they work while OpenCol/OpenCol is private.

## Run it

```sh
npm install
OPENCOL_TOKEN=$(gh auth token) npm run dev   # build and serve on http://localhost:8000
npm run dev -- --offline                     # again, from .cache/, no network
```

A page is plain HTML. `{{name}}` inserts a value the build knows (`{{version}}`,
`{{discordUrl}}`, `{{root}}` for links between pages); a name it does not know
stops the build, so a typo cannot ship.

## The design system

Pages use the classes of [col.css](https://github.com/OpenCol/web-ui) (`col-card`,
`col-btn`, `col-plate`...). Something another OpenCol page could use belongs
there, not in `assets/site.css`. The copy here is a web-ui release; after a new one,
`npm run sync-css -- vX.Y.Z` and commit.

## Deploying

`.github/workflows/pages.yml` builds and deploys on every push to `main`, every
morning, and by hand (*Actions > Pages > Run workflow*).

**While OpenCol/OpenCol is private**, the workflow cannot read its releases, and
the build falls back to `snapshot/`: a committed copy of the release list, the
CHANGELOG, its pictures and the latest zips. After an OpenCol release, refresh it
and push:

```sh
npm run snapshot      # needs gh, logged in with access to OpenCol/OpenCol
git add snapshot && git commit -m "Snapshot: OpenCol X.Y" && git push
```

(Or add an `OPENCOL_TOKEN` secret, a fine-grained token with read-only
*Contents* access to OpenCol/OpenCol, and the workflow reads the releases live.)
Once the repository is public, neither is needed and `snapshot/` can go.
