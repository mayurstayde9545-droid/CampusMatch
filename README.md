# CampusMatch (MVP)

A dating web app for college students across India. Sign up, swipe on profiles, match, chat.

## Run it

You need Node.js 22.13 or newer. There is nothing to install.

```
node server.js
```

Open http://localhost:3000. Data is stored in `campusmatch.db` next to `server.js`.

## What is in the MVP

- Sign up and log in with email or phone number and a password (passwords hashed with scrypt, session tokens)
- Optional Google sign-in when `GOOGLE_CLIENT_ID` is configured; Google identity tokens are verified server-side before linking or creating an account
- 18+ check at sign up (ages 18 to 40), plus a guidelines checkbox
- Profile: name, date of birth and calculated star sign, gender, who you want to see, college, city, year, bio, interests, hobbies and up to six photos
- Discovery settings: preferred age range, gender and distance radius; optional browser GPS coordinates for nearby filtering
- Swipe cards styled as college ID cards (like or pass)
- Separate Discover, Likes you, Matches, private Chat and Profile pages with responsive desktop and mobile navigation
- Profiles from your own city and college are shown first
- Match when two people like each other
- Private chat between matches (refreshes every 3 seconds)
- Block and report (reporting also blocks)
- Basic rate limits on login, sign up, messages and reports

## Not in the MVP yet

- College email verification, so anyone can type any college name
- SMS phone verification and other social providers (phone accounts use phone number plus password; Google OAuth requires a configured client ID)
- Moderation tools: reports are saved in the `reports` table, but there is no admin screen
- WebSocket chat and push notifications (the current chat polls for new messages)
- Password reset and email confirmation
- HTTPS, which you need when you put it online (use a host that provides it, or put Caddy or nginx in front)

## Before you launch to real students

Add college email verification and a way to review reports. Dating apps attract bad actors quickly, and these two things matter most for trust and safety. Also publish a privacy policy, since you are storing personal data.

Accounts and app data are stored in SQLite in `campusmatch.db`; passwords are scrypt hashed and sessions use random bearer tokens. Photos are stored as small image data URLs in the profile database. Location is optional and is only requested after the user presses **Use my location**. When both users share coordinates, discovery filters by the signed-in user's radius; profiles without coordinates can still appear based on city/college ranking. Chat uses WebSockets when available and falls back to three-second polling. For Google sign-in, set `GOOGLE_CLIENT_ID` to a Google OAuth web client ID before starting the server. Phone sign-in currently verifies the phone number and password but does not send an SMS code.

## Files

- `server.js`: API, database and static file server
- `public/`: the website (`index.html`, `style.css`, `app.js`)

