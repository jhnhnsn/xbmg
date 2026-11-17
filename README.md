# xbmediagrabber

A command-line tool to browse and download your Xbox screenshots and game clips.

It signs in to Xbox Live directly with your own Microsoft account and your own
Azure app registration. No third-party service sees your data. It has no npm
dependencies; it needs Node.js 20 or newer.

## One-time setup: create an Azure app registration

Xbox Live accepts sign-ins only from a registered app. The registration is free
and takes a few minutes.

1. Go to <https://entra.microsoft.com> (or **Microsoft Entra ID** in
   <https://portal.azure.com>) and sign in. If it asks you to create a free
   Azure account or directory, do that first.
2. Open **App registrations** → **New registration**.
   - **Name:** `xbmediagrabber` (any name works)
   - **Supported account types:** *Personal Microsoft accounts only*
   - **Redirect URI:** leave empty
   - Select **Register**.
3. On the app page, open **Authentication** and set
   **Allow public client flows** to **Yes**. Select **Save**.
   (If you do not see that switch, first select **Add a platform** →
   **Mobile and desktop applications** and tick
   `https://login.microsoftonline.com/common/oauth2/nativeclient`.)
4. On **Overview**, copy the **Application (client) ID**.

You do not need a client secret or any API permissions.

## Install

```sh
cd xbmediagrabber
npm link          # puts the `xbmg` command on your PATH
# or run it directly with: node bin/xbmg.js <command>
```

## Sign in

Run `xbmg`. When you are not signed in, it asks for your client ID, shows a
code, and copies the code to your clipboard. Press Enter to open the sign-in
page, enter the code, and sign in. The browser then loads your captures. If the
client ID is wrong or the app registration needs a change, the screen tells you
what to fix. Press `Ctrl-O` there to open the Microsoft Entra portal.

You can also sign in with a command:

```sh
xbmg login --client-id <your-application-client-id>
```

The tool shows a code and a URL. Open the URL, enter the code, and sign in with
the Microsoft account that has your Xbox profile. The tool saves the sign-in to
`~/.config/xbmediagrabber/session.json` (file mode 600) and refreshes it
automatically. After the first time, `xbmg login` alone is enough.

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
| `d` | Download the selection, or the current capture |
| `o` / `Enter` | Open the capture in your browser |
| `t` | Show all, screenshots or clips |
| `/` | Filter games by name |
| `p` | Show or hide image previews |
| `r` | Fetch the captures again |
| `L` (twice) | Sign out, to use a different account |
| `?` / `q` | Help / quit |

The mouse wheel scrolls and a click selects a row.

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

Run `xbmg --help` for all options. Run `npm test` to run the tests.
