# Family Hold'em

A single-device, pass-and-play Texas Hold'em game for up to 10 players. No
app to install, no accounts, no server — it's three files that run entirely
in the browser.

## How it works

- One device gets passed around the table. Before each hand, everyone takes
  a private turn to peek at their two hole cards (a "pass to X, tap to
  reveal" screen keeps them hidden from everyone else).
- During betting, the app tells you whose turn it is and hands them the
  fold/check/call/raise buttons after a privacy screen.
- Hand evaluation (including split pots and side pots for all-ins) is
  automatic.
- Player names and photos, and your chip/blind settings, are remembered on
  that device (via the browser's local storage) so you don't have to
  re-enter your family each game night.

## Deploying to GitHub Pages

1. Create a new GitHub repo (public or private both work for Pages) and
   upload `index.html`, `style.css`, and `script.js` to the root.
2. In the repo, go to **Settings → Pages**, and under "Build and
   deployment" set **Source** to "Deploy from a branch," branch `main`,
   folder `/ (root)`.
3. GitHub will give you a link like
   `https://yourusername.github.io/your-repo-name/` — that's the link to
   share with the family.
4. Any time you edit the files and push, the live link updates in a minute
   or two.

## About the photos

You don't need to upload photo files to the repo at all — at setup, tap any
player's avatar circle to choose a photo from that device, and it's stored
right in the browser alongside their name. That's simpler than managing
image files in the repo and works well since everyone shares one device.

If you'd rather commit photos to the repo itself (e.g. so they show up the
same way on any device you play from), there's an `assets/photos/` folder
ready for that — drop images in there and reference them by editing the
`ROSTER_DEFAULTS` you set up in the app once, or just re-upload each photo
through the app on whichever device you're using that night.

## Customizing

- Starting chips, small/big blind, and an optional "raise blinds every 4
  hands" toggle are all set on the setup screen before dealing.
- Colors, fonts, and layout live in `style.css` if you want to reskin it.
- The whole game engine (dealing, betting rules, hand evaluation, side
  pots) is in `script.js`, commented by section if you want to extend it —
  a chat/notes field, a tournament mode with multiple tables, etc.

## Known simplifications

This is built for a casual family game, not a cardroom, so a couple of
edge-case tournament rules are intentionally simplified: an all-in raise
for less than a full minimum raise still reopens betting to players who've
already acted (standard casino rules would sometimes disallow this). It
doesn't affect who wins a hand or how much they win — just, in rare cases,
whether someone gets one extra chance to act.
