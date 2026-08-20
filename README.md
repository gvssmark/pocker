# Family Hold'em — Online

Remote-play Texas Hold'em for up to 10 players, each on their own device,
anywhere in the world. Built on GitHub Pages (static hosting) + Firebase
Realtime Database (free tier) for live sync.

## One-time setup (about 10 minutes)

### 1. Create a Firebase project
1. Go to https://console.firebase.google.com, sign in with any Google account.
2. **Add project** → give it any name → you can skip Google Analytics.
3. Once created, click the **`</>`** (web) icon to register a web app. Give
   it a nickname (e.g. "family-holdem") — you don't need Firebase Hosting.
4. Firebase shows you a `firebaseConfig` object. Copy the values into
   `firebase-config.js` in this repo (replace the `PASTE_YOUR_...` placeholders).

### 2. Turn on Anonymous auth
In the Firebase console: **Build → Authentication → Get started → Sign-in
method → Anonymous → Enable**. This is how each player's device gets a
private identity without anyone needing an account or password.

### 3. Create the Realtime Database
**Build → Realtime Database → Create database** → pick any region → start
in **locked mode** (we're about to paste our own rules over the default).

### 4. Paste in the security rules
In the Realtime Database's **Rules** tab, replace the contents with what's
in `database.rules.json` in this repo, then **Publish**. This is what keeps
each player's hole cards private — only that player's device (and the
host, for dealing) can read them.

### 5. Deploy the files to GitHub Pages
Upload `index.html`, `style.css`, `engine.js`, `app.js`, and your filled-in
`firebase-config.js` to a GitHub repo, then **Settings → Pages** → deploy
from the `main` branch, root folder. Share the resulting link + a room code
with the family.

## How a game night works

1. Whoever creates the table becomes the **host** for that sitting — their
   device holds the shuffled deck in memory and reveals the flop/turn/river
   at the right moments, and settles each hand's payouts.
2. **The host needs to keep that browser tab open for the whole game.** If
   it closes mid-hand, the game pauses until they reopen the same link (the
   room code and everyone's chip counts are safely stored in Firebase, so
   nothing is lost — but a hand already in progress when the tab closes
   can't be recovered, since the not-yet-revealed cards only ever existed
   in that tab's memory, never on the server).
3. Everyone else just opens the link, enters the room code, and plays from
   wherever they are — phone, laptop, anywhere with a browser.
4. Each player only ever sees their own two hole cards, in a panel at the
   bottom of their own screen.

## Why it's built this way (and what that trades off)

A fully static site (GitHub Pages) can't run server logic, so there's no
way to have a fully hidden, trusted dealer the way a real casino app would.
The design here narrows that gap as much as it reasonably can for a home
game:
- Hole cards are stored per-player in Firebase, and the security rules
  mean only that player's own device (and the host, purely to *deliver*
  them) can read them — a casual glance at network traffic on someone
  else's device won't expose your cards.
- The tradeoff: this isn't hardened against a family member who's
  comfortable opening browser dev tools and deliberately poking at the
  app's own requests. For a trusted family game, that's a reasonable line
  to draw; it wouldn't be for anything with real money at stake among
  strangers.

## Cost

Firebase's free "Spark" plan needs no credit card and comfortably covers
this: a family game uses a tiny fraction of the free Realtime Database
quota (1 GiB stored, 10 GiB downloaded/month, 100 simultaneous
connections). You won't hit a paywall for this use case.

## Customizing

Same as before — `style.css` for the look, `engine.js` for the actual poker
rules (dealing, betting, hand evaluation, side pots — this file has no
Firebase or DOM code in it at all, so it's easy to test changes in
isolation), and `app.js` for the syncing/UI glue.

## A note on testing

The poker engine itself (`engine.js`) was tested extensively in isolation —
hand evaluation against known hands, side-pot math against multi-way
all-in scenarios, and full simulated games across 2–10 players (including
forced-elimination runs) with chip totals verified to balance exactly
every time. The Firebase wiring in `app.js` follows Firebase's standard,
well-documented patterns, but — since it talks to Firebase's live
servers — it couldn't be exercised end-to-end without your actual Firebase
project. **Test it yourself with two browser tabs (or your phone + laptop)
before game night**: create a table in one, join with the room code in the
other, and play a hand or two to confirm cards, turns, and chip counts all
behave as expected. If anything looks off, tell me what you're seeing and
I'll fix it.
