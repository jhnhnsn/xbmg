# xbmediagrabber

A command-line tool to browse and download your Xbox screenshots and game clips.

It signs in to Xbox Live directly with your own Microsoft account. Your tokens
go only from Microsoft to your computer, and no third-party service sees your
data. It has no npm dependencies; it needs Node.js 20 or newer. Inline video
needs [ffmpeg](https://ffmpeg.org) (`ffplay` for sound).

## Install

With [Homebrew](https://brew.sh) (it installs Node for you):

```sh
brew install jhnhnsn/tap/xbmg
```

With npm, you need [Node.js](https://nodejs.org) 20 or newer.

```sh
npm install -g xbmg    # then run: xbmg
npx xbmg               # or run it once without installing
xbmg browse --demo     # try it with made-up captures, no sign-in needed
```

With the install script, you need Node.js 20 or newer. It installs to
`~/.local/share/xbmg` and links `~/.local/bin/xbmg`, with no `sudo`:

```sh
curl -fsSL https://raw.githubusercontent.com/jhnhnsn/xbmg/main/install.sh | sh
```

To read the script before you run it:

```sh
curl -fsSL https://raw.githubusercontent.com/jhnhnsn/xbmg/main/install.sh | less
```

Run it again to upgrade. Set `XBMG_VERSION=v0.1.0` for a specific version, or
`XBMG_INSTALL_DIR` for a different folder. To uninstall:
`rm -rf ~/.local/share/xbmg ~/.local/bin/xbmg`.

For inline video, also install ffmpeg (for example `brew install ffmpeg`).

To run it from a clone instead:

```sh
git clone https://github.com/jhnhnsn/xbmg.git
cd xbmg
node bin/xbmg.js       # or "npm link" to put xbmg on your PATH
```

## Sign in

Run `xbmg`. When you are not signed in, it says so. Press Enter, and it opens
the Microsoft sign-in page in your web browser. Sign in with the account that
has your Xbox profile, and the terminal loads your captures. The header then
shows "Signed in as" and your gamertag. Press `L` to sign in as a different
user or to sign out.

On the sign-in screen, press `d` to sign in with a code instead of the browser,
for example when the browser shows an error. Over SSH, the code is the default,
because a browser on your own computer cannot reach the remote `localhost`.

You can also sign in with a command:

```sh
xbmg login
xbmg login --device-code    # sign in with a code instead
```

The tool saves the sign-in to `~/.config/xbmediagrabber/session.json` (file
mode 600) and refreshes it automatically. After the first time, `xbmg login`
alone is enough.

### How the browser sign-in works

The tool uses the OAuth 2.0 authorization code flow with PKCE. It starts a
one-time web server on `127.0.0.1` (and `::1`) on a random port, and Microsoft
sends your browser back to `http://localhost:<port>` after you sign in. The
server accepts only a response with the random `state` value of that sign-in,
and it stops after the sign-in. The tokens go only from Microsoft to your
computer.

### Use your own Azure app registration (optional)

By default the tool uses the project's app registration. Its client ID is in
`src/auth.js`; it is not a secret. To use your own registration instead, make
one as below and pass `--client-id <id>`, or set `XBMG_CLIENT_ID`.

Xbox Live accepts sign-ins only from a registered app. The registration is free
and takes a few minutes.

1. Go to <https://entra.microsoft.com> (or **Microsoft Entra ID** in
   <https://portal.azure.com>) and sign in. If it asks you to create a free
   Azure account or directory, do that first.
2. Open **App registrations** → **New registration**.
   - **Name:** `xbmediagrabber` (any name works)
   - **Supported account types:** *Personal Microsoft accounts only*
   - **Redirect URI:** select **Public client/native (mobile & desktop)** and
     type `http://localhost`
   - Select **Register**.
3. On the app page, open **Authentication** and set
   **Allow public client flows** to **Yes**. Select **Save**.
   (If you skipped the redirect URI, add it here: **Add a platform** →
   **Mobile and desktop applications** → custom redirect URI `http://localhost`.)
4. On **Overview**, copy the **Application (client) ID**.

You do not need a client secret or any API permissions.

## Browse in the terminal

```sh
xbmg                    # same as "xbmg browse"
xbmg browse -t shots    # start with screenshots only
xbmg browse --demo      # try it with made-up captures, no sign-in needed
```

This opens a full-screen browser with three panes: games, captures, and a
preview with the capture's thumbnail and details. Select captures and press
`d` to download them to `./xbox-captures` (or `-o <dir>`). A `✓` shows the
captures that you already downloaded.

| Key | Action |
| --- | --- |
| `↑` `↓` / `j` `k` | Move (`PgUp` `PgDn`, `g` `G` also work) |
| `←` `→` / `h` `l` / `Tab` | Change pane |
| `Space` | Select a capture (on a game: all its captures) |
| `a` / `Esc` | Select all / clear the selection |
| `Enter` / `v` | View the capture full size inside xbmg |
| `d` | Download the selection, or the current capture |
| `y` | Copy the download link (of the selection, or the capture) |
| `o` | Open the capture in your web browser |
| `t` | Show all, screenshots or clips |
| `/` | Filter games by name |
| `p` | Show or hide image previews |
| `r` | Fetch the captures again |
| `L` | Account: sign in as a different user, or sign out |
| `?` / `q` | Help / quit |

The mouse wheel scrolls and a click selects a row.

### Viewing captures

`Enter` opens the capture inside xbmg. For a screenshot, `←` `→` show the
previous and next capture. For a clip, `Space` plays and pauses, `←` `→` go
back and forward 5 seconds, `m` turns the sound off and on, and `[` `]` show the
previous and next capture. `y`, `d` and `o` work here too, and `Esc` closes the
view.

Clips play through ffmpeg at 15 frames per second and 640 pixels wide. Set
`XBMG_VIDEO_WIDTH` for sharper video if your terminal keeps up. A downloaded
clip plays from the file; other clips stream from Xbox.

### Sharing links

`y` copies the Xbox download link, which anyone can open. Xbox links are
temporary: the message shows when the link stops working. To share a capture
for longer, download it and share the file.

Image previews work in terminals that support the kitty graphics protocol
(kitty, Ghostty) or iTerm2 inline images (iTerm2, WezTerm). They do not work
inside tmux or screen. Set `XBMG_IMAGES=kitty`, `iterm` or `none` to override
the detection. The kitty protocol needs PNG, so the tool converts thumbnails
with `sips` (built into macOS), ImageMagick or ffmpeg. Thumbnails are cached
in `~/.cache/xbmediagrabber/thumbs`.

## Browse with commands

```sh
xbmg games                         # games with screenshot and clip counts
xbmg list                          # all captures, newest first
xbmg list -t clips -g forza        # clips from games whose name contains "forza"
xbmg list --since 7d               # the last 7 days
xbmg list --since 2026-10-01 --until 2026-10-31
xbmg list --json > captures.json   # full metadata, including thumbnail URLs
xbmg open 3f2a9c1b                 # open one capture in your browser (ID prefix from `list`)
```

## Download

```sh
xbmg download                          # everything, to ./xbox-captures
xbmg download -g halo -o ~/Pictures/Xbox
xbmg download -t shots --since 30d --hdr
xbmg download 3f2a9c1b 77e01d2c        # specific captures by ID prefix
xbmg download --dry-run                # show the file names, download nothing
```

Files go into one folder for each game:

```
xbox-captures/
  Halo Infinite/
    2026-11-10_20-30-05_3f2a9c1b.png
  Forza Horizon 5/
    2026-11-12_18-02-44_77e01d2c.mp4
```

- The file time is set to the capture time.
- Files that are already there with the correct size are skipped, so you can
  run the same command again to get only the new captures or to retry failures.
- `--hdr` gets the HDR original (`.jxr`) of screenshots when Xbox has one.
  Without it you get the standard image.
- `-j <n>` sets the number of parallel downloads (default 4).

## Limits

- The tool sees only captures that your console **uploaded to Xbox cloud
  storage**. Captures that are only on the console's local drive do not show.
- Xbox removes cloud captures after some time and when your cloud storage is
  full. Download what you want to keep.
- Download links are temporary. The tool gets fresh links each time it runs.

## Troubleshooting

- **`AADSTS700016` / app not found:** the client ID is wrong, or the app does not
  allow *Personal Microsoft accounts*.
- **`AADSTS7000218` / client secret necessary:** set
  **Allow public client flows** to **Yes** (setup step 3).
- **No Xbox profile / child account:** the tool shows the reason that Xbox gives.
- **Unexpected output:** add `--debug` to see the raw API responses.

## Commands

```
xbmg browse [filters] [--demo]    Full-screen browser with previews (default)
xbmg login [--client-id <id>]     Sign in with your Microsoft account
xbmg whoami                       Show the signed-in gamertag
xbmg logout                       Delete the saved sign-in
xbmg games                        List games with capture counts
xbmg list [filters]               List captures, newest first
xbmg open <id>                    Open a capture in your browser
xbmg download [ids...] [filters]  Download captures
```

Run `xbmg --help` for all options. Run `npm test` in a clone to run the tests.
