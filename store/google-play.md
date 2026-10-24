# Boxxie Share on Google Play

Everything to copy into Google Play Console. Images are in this folder.

## Store listing

**App name** (30 max): `Boxxie Share`

**Short description** (80 max):
`Watch your own films together with friends, and talk on video while you watch.`

**Full description:**

```
Film night, together, wherever your friends are.

Boxxie Share streams a film from your phone, tablet, TV or computer to your friends live, so everyone watches the same moment. Talk on a video call while you watch, chat, and react, without anything covering the film.

• Your own films: play a video file from your device and friends see it live, up to 4K.
• Private rooms: share a code or a link by WhatsApp, Messages or email. You let each person in.
• Video call and chat: faces sit small in the corner or move into the chat drawer. The film stays the star.
• Works on your TV: Android TV and Google TV run the app. Pair your phone to the TV for the camera, chat and a remote.
• Friends list: invite friends straight into your room with one tap.
• Safe by design: sign in with Google, Facebook or an email code. Block or report anyone, and the host can remove people at any time.
• Private: films, video and voice go directly between devices, encrypted. Chat isn't saved.

Boxxie Share is for videos you own or have permission to share. It doesn't work with streaming services and doesn't get around copy protection.
```

**Category:** Social (or Video Players & Editors) · **Tags:** watch party, video call
**Contact email:** your CONTACT_EMAIL · **Privacy policy:** `https://YOUR-GITHUB-NAME.github.io/boxxie-share/privacy.html`

### Graphics
| Asset | File |
| --- | --- |
| App icon 512×512 | `icon-512.png` |
| Feature graphic 1024×500 | `feature-graphic-1024x500.png` |
| Phone screenshots (2–8) | `phone-1-home.png`, `phone-2-watching.png`, `phone-3-paired-remote.png` |
| Android TV banner 1280×720 | `tv-banner-1280x720.png` |
| Android TV screenshots | `tv-1-home.png`, `tv-2-join-request.png`, `tv-3-pair-phone.png`, `tv-4-watching.png`, `tv-5-share-invite.png` |

## App content (Policy → App content)

**Privacy policy:** the link above.

**Ads:** No, the app doesn't contain ads.

**App access:** "All or some functionality is restricted". Add instructions:
```
Sign in with "Continue with email". Email: <REVIEW_EMAIL>  Code: <REVIEW_CODE>
To test a room: tap Start sharing with any video, then on a second device join with the code shown.
```
(Set the `REVIEW_EMAIL` and `REVIEW_CODE` secrets on the server first. See README.)

**Content rating questionnaire:** category **Social or communication**. Answer:
- Users can interact or exchange content (chat, video calls): **Yes**
- Shares the user's location with others: **No**
- Digital purchases: **No**
- No violence, sexual content, gambling or drugs in the app itself.

**Target audience:** **13 and over** only (13–15, 16–17, 18+). Not designed for children. Don't tick under-13 ages, or the Families policy applies.

**User-generated content:** the app has chat and video between users. It has:
- terms that ban objectionable content (`terms.html`), accepted at sign-in,
- in-app **Report** (tap a person) and **Report a problem** (Friends),
- in-app **Block**, which also stops friend requests, invites and room joins,
- host can remove anyone; reports are emailed to you for action.

**News app / Health / Financial / Government:** No.

**Account deletion:** in-app (Friends → Delete my account). Web link for the form: `https://YOUR-GITHUB-NAME.github.io/boxxie-share/privacy.html#delete`

**Photo and video permissions:** the Play version has none. Films are picked with Android's file picker.

**Foreground service / exact alarms / location / contacts / SMS:** not used.

## Data safety form

**Does the app collect or share user data?** Yes, collects. Doesn't share (Cloudflare and the email provider are service providers, which aren't "sharing").

**Is all data encrypted in transit?** Yes.
**Can users request deletion?** Yes (in app, and the web link above).

| Data type | Collected | Shared | Required? | Why |
| --- | --- | --- | --- | --- |
| Personal info → Name | Yes | No | Required | Account management, app functionality |
| Personal info → Email address | Yes | No | Required | Account management (sign-in), app functionality |
| Personal info → User IDs | Yes | No | Required | Account management |
| Messages → Other in-app messages | Yes | No | Required | App functionality (chat). Passed on live; only kept when included in a report (fraud prevention, security and compliance) |
| Photos and videos | No | | | Films and camera go device to device, end-to-end encrypted |
| Audio | No | | | Voice goes device to device, end-to-end encrypted |
| App activity, device IDs, location, contacts, financial, health | No | | | |

Profile photos come from Google or Facebook as a link and are shown to friends: if Play asks, list them under Photos (collected, account management).

## Before you submit: checklist

- [ ] Google Play developer account ($25 one-off), identity verified.
- [ ] Upload key created and the four `BOXXIE_*` secrets added (README: Google Play).
- [ ] **Build Android app** run → download **BoxxieShare-GooglePlay-aab** from the run page.
- [ ] Server secrets: `REVIEW_EMAIL`, `REVIEW_CODE`, `ADMIN_TOKEN`; repository variable `CONTACT_EMAIL`.
- [ ] Create app → package `com.boxxieshare.app`, free, app (not game).
- [ ] Fill in everything in "App content" above.
- [ ] Testing → Closed testing: upload the .aab, add at least **12 testers** (their Google emails), and keep them opted in for **14 days**.
- [ ] Release types → also add **Android TV** (Advanced settings → Form factors) and upload the TV banner and screenshots.
- [ ] After 14 days: Dashboard → **Apply for production**.
