# CampusMatch (MVP)

A dating web app for college students across India. Sign up, swipe on profiles, match, chat.

## Run it

You need Node.js 22.13 or newer.

```
npm install
npm start
```

Open http://localhost:3000. Data is stored in `campusmatch.db` next to `server.js` by default.

### Use local XAMPP/MySQL instead

1. Start **MySQL** in the XAMPP Control Panel.
2. Open phpMyAdmin at http://localhost/phpmyadmin and create a database named `campusmatch`.
3. Copy `.env.example` to a new file named `.env` in this folder. Set `MYSQL_USER` and `MYSQL_PASSWORD` to your XAMPP MySQL login. XAMPP commonly uses `root` with an empty password unless you changed it.
4. Run `npm install`, then `npm start`. CampusMatch creates its tables in the selected database when it starts.

Keep `.env` private. It contains database credentials. When `MYSQL_HOST` is set, the app uses MySQL; without it, the app uses the local SQLite file. A local XAMPP database works only with the app running on this PC. The Render-hosted site needs a separately hosted MySQL database and its connection settings entered in Render's private environment variables.

## What is in the MVP

- Sign up and log in with email or phone number and a password (passwords hashed with scrypt, session tokens)
- Optional Google sign-in when `GOOGLE_CLIENT_ID` is configured; Google identity tokens are verified server-side before linking or creating an account
- 18+ check at sign up (ages 18 to 40), plus a guidelines checkbox
- Profile: name, date of birth and calculated star sign, gender, who you want to see, college, city, year, bio, interests, hobbies and up to six photos
- Profile preferences: preferred age range and gender; Discover shows all other unblocked profiles not already swiped on, regardless of distance
- Swipe cards styled as college ID cards (like or pass)
- Separate Discover, Likes you, Matches, private Chat and Profile pages with responsive desktop and mobile navigation
- Profiles from your own city and college are shown first, but distance never filters the feed
- Match when two people like each other
- Private chat between matches (refreshes every 3 seconds)
- Block and report (reporting also blocks)
- Secure one-time password reset links (30-minute expiry) when Resend email settings are configured
- Basic rate limits on login, sign up, password reset, messages and reports

## Not in the MVP yet

- College email verification, so anyone can type any college name
- SMS phone verification and other social providers (phone accounts use phone number plus password; Google OAuth requires a configured client ID)
- Moderation tools: reports are saved in the `reports` table, but there is no admin screen
- WebSocket chat and push notifications (the current chat polls for new messages)
- Email confirmation
- HTTPS, which you need when you put it online (use a host that provides it, or put Caddy or nginx in front)

## Before you launch to real students

Add college email verification and a way to review reports. Dating apps attract bad actors quickly, and these two things matter most for trust and safety. Also publish a privacy policy, since you are storing personal data.

Accounts and app data use SQLite by default or MySQL when configured; passwords are scrypt hashed and sessions use random bearer tokens. Photos are stored as small image data URLs in the profile database. Discover shows other accounts not already swiped on or blocked, regardless of location. Chat uses WebSockets when available and falls back to three-second polling. For Google sign-in, set `GOOGLE_CLIENT_ID` to a Google OAuth web client ID before starting the server. Phone sign-in currently verifies the phone number and password but does not send an SMS code. To enable forgot-password emails, configure `RESEND_API_KEY`, `RESEND_FROM_EMAIL` (a verified sender in Resend), and `APP_URL` (the public site URL) in the host's private environment settings. Until configured, the app shows a friendly contact-the-site-owner message and no SMTP error. Reset tokens are stored hashed, expire after 30 minutes, work once, and invalidate active sessions after a password change.

## Files

- `server.js`: API, database and static file server
- `public/`: the website (`index.html`, `style.css`, `app.js`)
