# igrid 0.1

Image grid. Local boards of images captured from the web, shown as well as each image allows.

Runs on this Mac only, in Chrome, at http://localhost:4747. No login, no account, nothing leaves the machine except the requests that fetch the images you save.

## Run

```bash
cd /Users/sid/Code/igrid && npm install && npm start
```

Needs Node 22.5 or later (uses the built-in SQLite). The only dependency is `sharp`, for image work.

- Port: `IGRID_PORT` (default 4747). The extension is fixed to 4747.
- Data: `IGRID_DATA` (default `./data`): `igrid.db` plus `images/`. Back up that folder and you have everything.

## Always on

A login item keeps the server running: `~/Library/LaunchAgents/work.igrid.server.plist`. It starts at login, restarts the server if it stops, and logs to `~/Library/Logs/igrid.log`. With it installed there is no need to run `npm start`.

After changing server code, restart it:

```bash
cd /Users/sid/Code/igrid && launchctl kickstart -k gui/$(id -u)/work.igrid.server
```

To remove it:

```bash
cd /Users/sid/Code/igrid && launchctl bootout gui/$(id -u)/work.igrid.server && rm ~/Library/LaunchAgents/work.igrid.server.plist
```

## What it does

| Need | How |
| --- | --- |
| Boards | Create, rename (click the title), archive and restore. Boards are never deleted. |
| Capture | Right-click any image in Chrome, **Save to igrid**, pick a board (extension). Also: drag an image in from another window, paste with Cmd+V, add by address, upload files. |
| Grid | Size slider, tile shape (Auto follows the board's typical image), fit mode. Saved per board. |
| Order | Drag tiles, or use the arrows on a tile to send it to the top or bottom. New images go to the end. Nothing else ever reorders a board. |
| Names and tags | Optional, in the details view (pencil button or Space while hovering). |
| Search | In a board: names, tags, page titles, source sites. On the home page: across all boards. Tag chips filter. `/` focuses search. |
| Duplicates | An image whose file is byte-for-byte identical to one already on the board is not added again. Existing exact duplicates are removed when the server starts: the first copy stays and inherits any name, tags or link it lacked. |
| Delete | X on the tile, or Backspace while hovering. Undo for a few seconds; files are purged after 7 days. |
| Click-through | Clicking a tile opens the page it was saved from. |
| Pinterest | Paste a public board link. All pins, Pinterest's order, original resolution, each linked to its outbound page. Importing the same board again adds only new pins. |
| Theme | Follows the system; the button in the top bar cycles auto, light, dark. |

## Right-click capture (one-time)

1. Open `chrome://extensions`
2. Turn on Developer mode
3. Load unpacked, choose `/Users/sid/Code/igrid/extension`

The extension fetches the image inside Chrome, so it carries your session and works on sites that refuse outside requests. If a site blocks right-click, open the image in its own tab and right-click it there.

## How images are fitted

Each image is analysed once when it arrives (`lib/ingest.js`); the grid decides per tile (`fitTile` in `public/app.js`).

1. **Product shot on a flat backdrop, or a cut-out on transparency.** The stored view is trimmed to the subject, so items photographed with different margins come out the same size. Shown whole, on its own backdrop colour, never cropped.
2. **Shape nearly matches the tile.** Fills the tile.
3. **Flat colour on the two sides where bars would appear.** Shown whole; the tile continues that colour, so the bars are invisible.
4. **A photo that loses a third or less when cropped.** Fills the tile, with the crop window placed over the point of most visual interest (tall images favour the top).
5. **Anything further off.** Shown whole over a soft blurred continuation of its own edges.

Fit mode can override this per board: Fill tiles (always crop) or Show whole image (never crop). EXIF rotation is applied. Originals are kept untouched and shown in the details view.

## Known limits in 0.1

- Secret Pinterest boards cannot be imported (the importer reads what Pinterest shows a signed-out visitor). Pins inside board sections are untested.
- Pinterest's endpoints are unofficial and can change without notice.
- The right-click menu saves the image at the size the page is displaying; some sites serve a larger file elsewhere.
- Animated GIFs show their first frame in the grid.
- The extension's board list refreshes when igrid changes it and once a minute otherwise.
- The server must be running for capture to work.

## Layout

```
server.js            HTTP, SQLite, routes
lib/ingest.js        image analysis and stored views
lib/pinterest.js     board import
public/              the app (plain JS, no build)
extension/           Chrome extension (Manifest V3)
data/                your boards and images (not in git)
```

## License

MIT. See [LICENSE](LICENSE).
