# Boxxie Share

Watch your own films together on Fire TV, Android TV, Android phones, iPhones and computers.
Share a code, approve who gets in, and talk on video while you watch.

- **Share a film file** from a Fire TV Stick, Android TV, Android phone or computer.
- **Share your screen** from a computer. Start sharing, put anything on, and friends join whenever they like.
- **Join with a code** (like `TKME-2ZAY`) or a link. The host approves every person.
- **Accounts:** everyone signs in with Google, Facebook or an emailed code. Add friends by
  email and invite them into a room in one tap. Invited friends go straight in; anyone else
  still needs you to press **Let in**.
- **Video call and chat** alongside the film, with quick reactions for TV remotes. TVs pair
  a phone by QR code for the camera and mic.
- **Free to run.** It uses GitHub Pages for the app, GitHub Releases for the Android download, and Cloudflare's free plan for the connection server.

> Boxxie Share is for films **you own** (your own video files). It doesn't share Netflix,
> Prime, Disney+, IPTV services or other paid streams. Those services block screen sharing,
> and re-broadcasting them isn't allowed. Friends can each watch their own subscription
> and still use the Boxxie Share video call and chat alongside it.

---

## How it works

```
 Your Fire TV ──── film (encrypted, direct) ────▶ Friend's TV / phone
      │                                               │
      └──── "who's here, let them in, chat" ──────────┘
                 Connection server (Cloudflare, free)
```

- The film goes **straight from your device to your friends**, encrypted by WebRTC, the
  technology video calls use. The server never sees or stores it.
- The server only does introductions, approvals and chat.
- Your home broadband upload speed sets the limit. **About 4–6 friends in HD** is typical
  in the UK. You choose the limit (3–8) when you open a room.

### Security

| Protection | What it does |
|---|---|
| 8-character random codes | About 850 billion combinations, without confusable letters (no 0/O, 1/I/L) |
| Sign-in required | Only signed-in people can open or join rooms. Names come from accounts, so nobody can pretend to be someone else |
| Host approval | Nobody gets in until you press **Let in** (or you invited them) |
| Lock room | Stops anyone else asking to join |
| Remove | Kicks someone out straight away |
| Guessing protection | 8 wrong codes from one connection = blocked for 15 minutes |
| Codes expire | When you end the room, or after 12 hours. Used codes are never reused |
| Host secret | Only the device that opened the room can control it. The secret is stored only as a hash |
| Website lock | The server only accepts your own Boxxie Share website |
| Encryption | Film, video call and chat all travel over encrypted connections |

---

## Setup (about 20 minutes, once)

You need a free **GitHub** account and a free **Cloudflare** account.

### Step 1: Put the project on GitHub

1. Sign in at github.com and create a **new public repository** called `boxxie-share`.
   GitHub Pages is free for public repositories. The code contains no passwords.
2. Upload everything in this folder. The easiest way is **GitHub Desktop**: clone the empty
   repository, copy these files into it, then commit and push. If you use the website's
   *Upload files* button instead, make sure the hidden `.github` folder is included.

### Step 2: Connect Cloudflare (for the connection server)

1. Create a free account at dash.cloudflare.com. Open **Workers & Pages** once so
   Cloudflare sets up your free `workers.dev` address.
2. Go to **My Profile → API Tokens → Create Token** and choose the **Edit Cloudflare
   Workers** template. Create the token and copy it.
3. Copy your **Account ID**, shown on the Workers & Pages overview page.
4. In your GitHub repository, go to **Settings → Secrets and variables → Actions → New
   repository secret** and add:
   - `CLOUDFLARE_API_TOKEN`: the token
   - `CLOUDFLARE_ACCOUNT_ID`: the account ID

### Step 3: Deploy the server

1. In GitHub, open **Actions → Deploy server → Run workflow**.
2. When it finishes, open the run. Its summary shows the server address, something like
   `https://boxxie-share-server.yourname.workers.dev`.
3. Go to **Settings → Secrets and variables → Actions → Variables tab → New repository
   variable**. Name it `SERVER_URL` and paste the address as its value.

### Step 4: Publish the app website

1. **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. **Actions → Deploy web app → Run workflow**.
3. Your app is now live at `https://YOUR-USERNAME.github.io/boxxie-share/`.

### Step 5: Switch on sign-in (Google, Facebook, email)

Everyone must sign in to use Boxxie Share. Turn on at least one option. Each takes about
10 minutes and is free. Your server address from Step 3 is `SERVER` below, for example
`https://boxxie-share-server.yourname.workers.dev`.

Add every key below in Cloudflare: **Workers & Pages → boxxie-share-server → Settings →
Variables and Secrets → Add**, choosing **Secret**. The option appears in the app straight away.

**Email codes (recommended first: no review needed)**

1. Create a free account at brevo.com (300 emails a day free).
2. **Senders, Domains & Dedicated IPs → Senders → Add a sender**. Use your own email address
   and confirm it from your inbox.
3. **SMTP & API → API Keys → Generate a new API key** and copy it.
4. Add the secrets `EMAIL_PROVIDER` = `brevo`, `EMAIL_API_KEY` = the key, and
   `EMAIL_FROM` = `Boxxie Share <the sender email you confirmed>`.

**Google**

1. Go to console.cloud.google.com and create a project called `Boxxie Share`.
2. **APIs & Services → OAuth consent screen**: choose **External**, app name `Boxxie Share`,
   your email for support and contact, and add your privacy page
   `https://YOUR-GITHUB-NAME.github.io/boxxie-share/privacy.html`. Publish the app. Basic
   sign-in (name, email, photo) doesn't need Google's review.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**, type **Web
   application**. Under **Authorised redirect URIs** add `SERVER/auth/google/callback`.
4. Add the secrets `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

**Facebook**

1. Go to developers.facebook.com, choose **Create app**, and pick the use case for
   **Facebook Login** (authenticate and request data from users).
2. In the Facebook Login settings, under **Valid OAuth Redirect URIs**, add
   `SERVER/auth/facebook/callback`.
3. In **App settings → Basic**, set the privacy policy URL and the data deletion
   instructions URL to `https://YOUR-GITHUB-NAME.github.io/boxxie-share/privacy.html`. Then
   switch the app to **Live**.
4. Add the secrets `FACEBOOK_APP_ID` and `FACEBOOK_APP_SECRET` (from **App settings → Basic**).

**Your contact email on the privacy page:** in GitHub, add a repository variable
`CONTACT_EMAIL` (like `SERVER_URL` in Step 3), then re-run **Deploy web app**.

**TVs sign in by QR code.** Google and Facebook don't allow their sign-in pages inside apps,
so the TV app shows a QR code instead. Scan it with a phone that's signed in, press **Yes,
sign in the TV**, and the TV signs itself in. Email codes also work on the TV.

### Step 6: Build the Fire TV / Android app

1. **Actions → Build Android app → Run workflow**. It takes about 5 minutes.
2. The app appears under **Releases** as `BoxxieShare.apk`. This link always gets the
   newest version:
   `https://github.com/YOUR-USERNAME/boxxie-share/releases/latest/download/BoxxieShare.apk`

From now on, any change you push to `web/`, `server/` or `android/` redeploys automatically.

---

## Installing on each device

### Fire TV Stick

1. On the Fire TV, search for and install **Downloader** (free, by AFTVnews).
2. Go to **Settings → My Fire TV → Developer options → Install unknown apps** and turn on
   **Downloader**. If you can't see *Developer options*, go to **Settings → My Fire TV →
   About** and click the device name 7 times.
3. Open Downloader and type your APK link from Step 6. Install it, then open
   **Boxxie Share** from your apps.

### Android TV / Google TV

Same as Fire TV: install **Downloader** from the Play Store, allow it to install unknown
apps (**Settings → Apps → Security & restrictions → Unknown sources**), then use the APK link.

### Android phone or tablet

The same `BoxxieShare.apk` the TVs use is a real app on phones and tablets too:
- open the APK link in Chrome, allow Chrome to install apps when asked, then **Install**, or
- open your website link in Chrome and choose **Install app** (or **Add to Home screen**).

Android phones can watch, chat, video call, pair with a TV and share a video file. Android
doesn't let browsers capture the phone's screen, so **My screen** is for computers.

### iPhone and iPad

Open your website link in **Safari**, tap **Share → Add to Home Screen**. iPhones can
**watch, chat and video call**. Apple doesn't allow web apps to share a film, so the host
needs to be on Android, Fire TV or a computer.

### Sharing your TV or phone screen (Android app)

In the Boxxie Share app on Fire TV, Android TV or an Android phone, choose **TV screen** (or
**Phone screen**) and press **Start sharing**. Accept Android's "Start recording or casting?"
pop-up, then press **Home** and open any app: friends see it live, with sound on Android 10 and
newer. Netflix, Prime and other paid apps show black: they block screen capture.

While the TV shows another app, let people in from your **paired phone**: their requests appear
there. Stop from the Boxxie Share app (**Stop sharing**) or the Android notification.

Some 2025 Fire TV Sticks run Amazon's Vega system and can't install Android apps at all.
iPhones and iPads can't share their screen from a website (Apple only allows it for App Store
apps); they can watch, chat and call.

### Apple TV

Apple TV has no web browser, and a native tvOS app would need a paid Apple developer
account to install. Instead, an iPhone, iPad or Mac in the room sends the film to the
Apple TV with **Screen Mirroring**:

1. Join the room on the iPhone (open the invite link in Safari).
2. Tap the **Apple TV** button in the bottom bar. It shows these steps.
3. Open Control Center, tap **Screen Mirroring**, choose the Apple TV.
4. Tap **Film full screen** and turn the phone sideways: the film fills the TV.

Keep the phone on the same Wi-Fi as the Apple TV. For the call, use headphones or a second
phone, so the TV doesn't echo.

### Computers

Just open the website link in Chrome, Edge or Firefox. Computers can host or watch.

---

## Using it

**To share a film file:** open Boxxie Share → **Share** → **A video file** → choose the video →
**Open the room**. Tell friends the code on screen, or press **Share link**. When someone asks to join,
press **Let in**. Use the play/pause buttons or your remote's play button.

**To share your screen (computers):** **Share** → **My screen** → **Open the room**. Your browser
asks what to share: pick the whole screen, a window or a tab, and tick **Share audio** for sound.
Now put on whatever you want to watch. Friends can join at any time with the code. Use
**Share something else** to switch, or **Stop sharing** to pause (friends stay in the room).
On a TV or phone, use **A video file** for now. Android only lets apps record the screen
through a special permission, which needs an extra native part of the app (see *What's next*).

**To join:** open Boxxie Share → **Join with a code**, type the code and your name, and wait
for the host to let you in. If the film starts silently, press **Turn sound on**.

**Video call:** the call is built in. Faces sit in the sidebar above the chat, never over
the film. It's encrypted device to device.

- **On a phone, tablet or laptop:** press **Join video call**.
- **On a TV (no camera):** press **Use your phone for the video call**. The TV shows a QR
  code. Scan it with your phone's camera, or type the longer code on the phone's Boxxie Share
  home screen. The phone joins as that TV's camera and mic straight away. It needs no
  approval, doesn't take a place in the room, and isn't sent the film. Call sound plays from
  the phone and the TV stays quiet, so there's no echo. The film keeps playing on the TV.
  The host can pair their own phone the same way.

**On a TV remote:** the arrows move between buttons, the centre button presses them, and Back
asks before leaving a room.

### Film files

- **MP4 (H.264 + AAC)** plays everywhere and is the safest choice.
- MKV files sometimes won't play inside the app. Converting to MP4 with the free
  HandBrake app fixes this.
- On Fire TV, copy films onto the stick or plug in a USB drive (newer models). The app
  lists the videos it finds.

---

## Optional: better connections on mobile data

Most home connections link up directly. Some networks, such as mobile data, some offices and
some routers, need a relay. Cloudflare's relay is free for the first 1,000 GB each month:

1. In Cloudflare, open **Realtime → TURN** and create a TURN key.
2. In **Workers & Pages → boxxie-share-server → Settings → Variables and Secrets**, add two
   **secrets**: `TURN_KEY_ID` and `TURN_KEY_API_TOKEN`, from the key you created.

The relay only carries encrypted data, so Cloudflare can't see the film.

---

## What's next

- **Screen sharing from Fire TV / Android TV / Android phones.** Android allows it through its
  screen-recording permission ("Start recording or casting?"), but a web page can't use that.
  It needs a native capture module added to the Android app. Fire TV supports it on Fire OS 7
  and newer. Protected apps (Netflix and so on) will still show black.

## Google Play

The app is built to Google Play's rules (Android 16 target, no video-library permission,
block and report, terms, account deletion). Everything to paste into Play Console (the
listing, data safety answers, content rating and a checklist) is in
[`store/google-play.md`](store/google-play.md), with the icon, feature graphic, TV banner
and screenshots next to it.

Two versions are built every time:

| File | For | Films come from |
| --- | --- | --- |
| `BoxxieShare.apk` (GitHub Releases) | Fire TV, Downloader, Amazon Appstore | a built-in list of the device's videos, or the file picker |
| `BoxxieShare-GooglePlay.aab` (run page → Artifacts) | Google Play | Android's file picker only |

### 1. Make your upload key (once, keep it safe)

On any computer with Java (for example from adoptium.net):

```
keytool -genkeypair -v -keystore boxxie-upload.jks -alias upload -keyalg RSA -keysize 2048 -validity 10000
```

It asks for a password; remember it. Then turn the file into text for GitHub:
- Mac: `base64 -i boxxie-upload.jks | pbcopy` (copies it)
- Windows PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("boxxie-upload.jks")) | Set-Clipboard`

In GitHub: **Settings → Secrets and variables → Actions → New repository secret**:
`BOXXIE_KEYSTORE_BASE64` (paste), `BOXXIE_KEYSTORE_PASSWORD`, `BOXXIE_KEY_ALIAS` (`upload`),
`BOXXIE_KEY_PASSWORD` (same password unless you chose another).

Keep `boxxie-upload.jks` and the password backed up. Google Play keeps the real app signing
key, so if you lose the upload key you can ask Google to reset it.

After this, the Fire TV APK is signed with the new key too: uninstall the old app once and
install the new one.

### 2. Server settings for review and reports

In Cloudflare (**Workers & Pages → boxxie-share-server → Settings → Variables and Secrets**):

| Secret | What it does |
| --- | --- |
| `REVIEW_EMAIL`, `REVIEW_CODE` | A review account for Google: that email signs in with that fixed 6-digit code, no email sent. Put both in Play Console → App access. |
| `ADMIN_TOKEN` | Any long random text. Each report email then has a "Review and ban this account" link. |
| `REPORT_EMAIL` | Where reports go. If not set, the `CONTACT_EMAIL` repository variable is used. |

### 3. Build, test and publish

1. **Actions → Build Android app → Run workflow**, then download **BoxxieShare-GooglePlay-aab**.
2. In Play Console create the app (package `com.boxxieshare.app`) and fill in App content from
   `store/google-play.md`.
3. New personal developer accounts must run a **closed test with at least 12 testers for
   14 days** before going public. Upload the .aab to Closed testing and invite them.
4. Add the **Android TV** form factor with the TV banner and screenshots.
5. After 14 days, apply for production.

Amazon Appstore (Fire TV) takes the `BoxxieShare.apk` from Releases.

---

## Project layout

```
web/        The app (one page, installable). Hosted on GitHub Pages.
server/     Connection server: rooms, codes, approvals, chat. Cloudflare Worker.
android/    Fire TV / Android TV / phone app. A locked-down shell around the web app.
brand/      Boxxie logos.
.github/    Automatic deploy and build workflows.
```

## Testing on your own computer

Needs Node.js 22.

```bash
cd server
npm test                                                      # server logic and security checks
node --import ./test/register.mjs test/devserver.mjs 8788     # then open http://127.0.0.1:8788
```

Accounts are tested too: `test/e2e_accounts.py` uses pretend Google and Facebook pages
served by the test server, and email codes it can read back.

`test/e2e.py` (Python + Playwright) runs a full host-plus-two-friends test in Chromium:
streaming, video call, chat, lock, remove and end. `test/e2e_screen.py` tests screen sharing
and `test/e2e_pair.py` tests pairing phones with TVs for the video call.
