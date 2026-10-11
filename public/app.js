// CampusMatch MVP frontend: sign up, swipe, match, chat.
(() => {
  const app = document.getElementById('app');
  const state = { token: null, user: null, cards: [], matches: [], googleTicket: null, googleEmail: '', googleName: '' };
  let cleanup = null;

  try { state.token = localStorage.getItem('cm_token'); } catch {}

  // ---------- helpers ----------
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    let value;
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'value') value = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    if (value !== undefined) el.value = value;
    return el;
  }

  async function api(method, path, body) {
    const res = await fetch('/api' + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      const err = new Error(data.error || 'Something went wrong. Try again.');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function toast(msg) {
    const t = h('div', { class: 'toast', role: 'status' }, msg);
    document.body.append(t);
    setTimeout(() => t.remove(), 3500);
  }

  const COLORS = ['#d81e5b', '#0b7d73', '#23245c', '#8a3ffc', '#b5530b', '#1f6feb'];
  const colorFor = (id) => COLORS[id % COLORS.length];
  const initial = (u) => (u.name || '?').trim().charAt(0).toUpperCase();

  async function optimizePhoto(file) {
    if (file.size > 12_000_000) throw new Error('Each photo must be smaller than 12 MB.');
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
    for (let quality = .84; quality >= .4; quality -= .08) {
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (blob && blob.size <= 110_000) return await new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result || '')); reader.onerror = reject; reader.readAsDataURL(blob);
      });
    }
    throw new Error('Could not optimize that photo. Try a smaller image.');
  }

  function setSession(token, user) {
    state.token = token; state.user = user;
    try { localStorage.setItem('cm_token', token); } catch {}
  }
  function clearSession() {
    state.token = null; state.user = null; state.cards = []; state.matches = [];
    try { localStorage.removeItem('cm_token'); } catch {}
  }

  async function googleSignIn(target) {
    try {
      const config = await api('GET', '/config');
      if (!config.google_client_id) { target.append(h('p', { class: 'hint' }, 'Google sign-in is available when the site owner configures its Google OAuth client ID.')); return; }
      if (!window.google?.accounts?.id) {
        await new Promise((resolve, reject) => {
          const script = h('script', { src: 'https://accounts.google.com/gsi/client', async: true, defer: true });
          script.onload = resolve; script.onerror = reject; document.head.append(script);
        });
      }
      window.google.accounts.id.initialize({ client_id: config.google_client_id, callback: async response => {
        try {
          const result = await api('POST', '/auth/google', { credential: response.credential });
          if (result.token) { setSession(result.token, result.user); state.googleTicket = null; location.hash = '#/discover'; route(); }
          else { state.googleTicket = result.ticket; state.googleEmail = result.email; state.googleName = result.name; location.hash = '#/signup'; route(); }
        } catch (e) { toast(e.message); }
      } });
      window.google.accounts.id.renderButton(target, { theme: 'outline', size: 'large', text: 'continue_with', shape: 'pill', width: 320 });
    } catch { target.append(h('p', { class: 'hint' }, 'Google sign-in could not load. You can continue with email or phone.')); }
  }

  // ---------- layout ----------
  function shell(content, tab) {
    app.replaceChildren();
    const header = h('div', { class: 'top' },
      h('a', { class: 'logo', href: tab ? '#/discover' : '#/' }, h('span', { class: 'brand-mark' }, '♡'), h('span', {}, 'campusmatch')),
      tab ? h('span', { class: 'top-note' }, 'good people, same campus energy') : null);
    const nav = tab ? h('nav', { class: 'nav', 'aria-label': 'Main' }, h('div', {},
      h('a', { href: '#/discover', 'aria-current': tab === 'discover' ? 'page' : null }, h('span', {}, '⌕'), ' Discover'),
      h('a', { href: '#/likes', 'aria-current': tab === 'likes' ? 'page' : null }, h('span', {}, '♡'), ' Likes'),
      h('a', { href: '#/matches', 'aria-current': tab === 'matches' ? 'page' : null }, h('span', {}, '✦'), ' Matches'),
      h('a', { href: '#/profile', 'aria-current': tab === 'profile' ? 'page' : null }, h('span', {}, '◉'), ' Profile'),
      h('button', { type: 'button', onclick: logout }, 'Log out'))) : null;
    app.append(h('main', { class: 'shell' }, header, nav, content));
  }

  async function logout() {
    try { await api('POST', '/logout'); } catch {}
    clearSession();
    location.hash = '#/';
    route();
  }

  // ---------- landing ----------
  function viewLanding() {
    const copy = h('div', { class: 'hero-copy' },
        h('span', { class: 'eyebrow' }, 'YOUR CAMPUS, YOUR KIND OF CONNECTION'),
        h('h1', {}, 'A little closer to ', h('em', {}, 'something real.')),
        h('p', {}, 'Meet people who get the late-night library runs, the canteen orders, and the little things that make campus yours.'),
        h('div', { class: 'row' },
          h('a', { class: 'btn primary', href: '#/signup' }, 'Find your people', h('span', {}, '↗')),
          h('a', { class: 'text-link', href: '#/login' }, 'I already have an account')),
        h('p', { class: 'hint' }, 'A thoughtful space for students 18 and over.'));
    const art = h('div', { class: 'hero-art', 'aria-hidden': 'true' },
        h('div', { class: 'hero-orbit orbit-a' }), h('div', { class: 'hero-orbit orbit-b' }),
        h('div', { class: 'hero-tag tag-top' }, '✦  MADE FOR CAMPUS CONNECTIONS'),
        h('div', { class: 'hero-person person-back' }, h('span', {}, 'R'), h('small', {}, 'same taste in playlists')),
        h('div', { class: 'hero-person person-front' }, h('span', {}, 'A'), h('small', {}, 'met between classes')),
        h('div', { class: 'hero-tag tag-bottom' }, h('b', {}, '01 / 03'), '  YOUR NEXT CHAPTER'));
    const footnote = h('div', { class: 'hero-footnote' }, h('span', {}, 'REAL PEOPLE'), h('i', {}), h('span', {}, 'SHARED INTERESTS'), h('i', {}), h('span', {}, 'BETTER CONVERSATIONS'));
    shell(h('section', { class: 'hero' }, copy, art, footnote));
  }

  // ---------- auth ----------
  function viewLogin() {
    const social = h('div', { class: 'social-login' });
    const err = h('p', { class: 'error', role: 'alert' });
    const form = h('form', { class: 'stack', onsubmit: async (e) => {
      e.preventDefault(); err.textContent = '';
      try {
        const r = await api('POST', '/login', { identifier: form.identifier.value, password: form.password.value });
        setSession(r.token, r.user);
        location.hash = '#/discover'; route();
      } catch (ex) { err.textContent = ex.message; }
    } },
      h('label', {}, 'Email or phone number', h('input', { name: 'identifier', autocomplete: 'username', placeholder: 'you@example.com or +919876543210', required: true })),
      h('label', {}, 'Password', h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true })),
      err,
      h('button', { class: 'btn primary', type: 'submit' }, 'Log in'),
      h('p', { class: 'hint' }, h('a', { href: '#/forgot-password' }, 'Forgot password?')),
      h('p', { class: 'hint' }, 'New here? ', h('a', { href: '#/signup' }, 'Create your profile')));
    shell(h('div', {}, h('h2', {}, 'Log in'), social, form));
    googleSignIn(social);
  }

  function viewForgotPassword() {
    const status = h('p', { class: 'hint', role: 'status' });
    const err = h('p', { class: 'error', role: 'alert' });
    const form = h('form', { class: 'stack', onsubmit: async e => {
      e.preventDefault(); err.textContent = ''; status.textContent = '';
      try {
        const r = await api('POST', '/password/forgot', { email: form.email.value });
        status.textContent = r.enabled ? r.message : 'Password recovery is not set up on this site yet. Please contact the site owner for help.';
        if (r.enabled) form.reset();
      } catch (ex) { err.textContent = ex.message; }
    } },
      h('label', {}, 'Email address', h('input', { name: 'email', type: 'email', autocomplete: 'email', required: true, placeholder: 'you@example.com' })),
      err, status, h('button', { class: 'btn primary', type: 'submit' }, 'Send reset link'),
      h('p', { class: 'hint' }, h('a', { href: '#/login' }, 'Back to log in')));
    shell(h('div', {}, h('h2', {}, 'Reset your password'), h('p', { class: 'hint' }, 'Enter the email address on your account and we’ll send a secure reset link.'), form));
  }

  function viewResetPassword(token) {
    const status = h('p', { class: 'hint', role: 'status' });
    const err = h('p', { class: 'error', role: 'alert' });
    const form = h('form', { class: 'stack', onsubmit: async e => {
      e.preventDefault(); err.textContent = ''; status.textContent = '';
      if (form.password.value !== form.confirm.value) { err.textContent = 'Those passwords do not match.'; return; }
      try {
        await api('POST', '/password/reset', { token, password: form.password.value });
        status.textContent = 'Password changed. You can now log in with your new password.';
        form.reset();
        setTimeout(() => { location.hash = '#/login'; route(); }, 1200);
      } catch (ex) { err.textContent = ex.message; }
    } },
      h('label', {}, 'New password', h('input', { name: 'password', type: 'password', minlength: 8, maxlength: 200, autocomplete: 'new-password', required: true })),
      h('label', {}, 'Confirm new password', h('input', { name: 'confirm', type: 'password', minlength: 8, maxlength: 200, autocomplete: 'new-password', required: true })),
      err, status, h('button', { class: 'btn primary', type: 'submit' }, 'Save new password'),
      h('p', { class: 'hint' }, h('a', { href: '#/forgot-password' }, 'Request another reset link')));
    shell(h('div', {}, h('h2', {}, 'Choose a new password'), form));
  }

  const COLLEGES = ['IIT Bombay', 'IIT Delhi', 'IIT Madras', 'NIT Trichy', 'BITS Pilani', 'Delhi University', 'Fergusson College', 'COEP Pune', 'Christ University', 'Symbiosis Pune', 'Mumbai University', 'Anna University', 'VIT Vellore', 'Manipal University', 'JNU', 'Jadavpur University'];
  const YEARS = ['1st year', '2nd year', '3rd year', '4th year', '5th year', 'Postgraduate', 'PhD'];

  function viewSignup() {
    const social = h('div', { class: 'social-login' });
    const err = h('p', { class: 'error', role: 'alert' });
    const t = new Date();
    const dobMax = new Date(t.getFullYear() - 18, t.getMonth(), t.getDate()).toISOString().slice(0, 10);
    const dobMin = new Date(t.getFullYear() - 40, t.getMonth(), t.getDate()).toISOString().slice(0, 10);
    const select = (name, opts) => h('select', { name, required: true }, opts.map(([v, l]) => h('option', { value: v }, l)));

    const photoInput = h('input', { name: 'photo', type: 'file', accept: 'image/jpeg,image/png,image/webp', multiple: true });
    const photoState = { data: [] };
    photoInput.addEventListener('change', async () => {
      const files = [...(photoInput.files || [])];
      if (files.length > 6) { photoInput.value = ''; photoState.data = []; toast('Choose up to six photos.'); return; }
      try { photoState.data = await Promise.all(files.map(optimizePhoto)); }
      catch (e) { photoInput.value = ''; photoState.data = []; toast(e.message); }
    });
    const form = h('form', { class: 'stack', onsubmit: async (e) => {
      e.preventDefault(); err.textContent = '';
      const f = form.elements;
      try {
        const r = await api('POST', '/signup', {
          email: state.googleTicket ? state.googleEmail : f.email.value, phone: f.phone.value, password: f.password.value, google_ticket: state.googleTicket || undefined, dob: f.dob.value, name: f.name.value,
          gender: f.gender.value, interested_in: f.interested_in.value, college: f.college.value,
          city: f.city.value, year: f.year.value, bio: f.bio.value, agreed: f.agreed.checked,
          min_age: f.min_age.value, max_age: f.max_age.value,
          interests: f.interests.value.split(',').map(s => s.trim()).filter(Boolean),
          hobbies: f.hobbies.value.split(',').map(s => s.trim()).filter(Boolean),
          photos: photoState.data,
        });
        setSession(r.token, r.user);
        state.googleTicket = null;
        location.hash = '#/discover'; route();
      } catch (ex) { err.textContent = ex.message; }
    } },
      h('label', {}, 'Name', h('input', { name: 'name', maxlength: 50, autocomplete: 'given-name', value: state.googleName, required: true })),
      h('label', {}, 'Email (optional)', h('input', { name: 'email', type: 'email', autocomplete: 'email', placeholder: 'you@example.com', value: state.googleEmail, readonly: !!state.googleTicket })),
      h('label', {}, 'Phone number (optional)', h('input', { name: 'phone', type: 'tel', autocomplete: 'tel', placeholder: '+919876543210' }), h('span', { class: 'hint' }, 'Enter a number with country code. Add an email or phone number.')),
      h('label', {}, 'Password', h('input', { name: 'password', type: 'password', minlength: 8, autocomplete: 'new-password', required: !state.googleTicket }), h('span', { class: 'hint' }, state.googleTicket ? 'Google verified your email; no password is needed.' : 'At least 8 characters')),
      h('label', {}, 'Date of birth', h('input', { name: 'dob', type: 'date', min: dobMin, max: dobMax, autocomplete: 'bday', required: true }), h('span', { class: 'hint' }, 'Your star sign is calculated from your birthday.')),
      h('div', { class: 'two' },
        h('label', {}, 'I am', select('gender', [['woman', 'A woman'], ['man', 'A man'], ['nonbinary', 'Non-binary']])),
        h('label', {}, 'Show me', select('interested_in', [['everyone', 'Everyone'], ['women', 'Women'], ['men', 'Men']]))),
      h('label', {}, 'College', h('input', { name: 'college', list: 'colleges', maxlength: 100, required: true }),
        h('datalist', { id: 'colleges' }, COLLEGES.map(c => h('option', { value: c })))),
      h('div', { class: 'two' },
        h('label', {}, 'City', h('input', { name: 'city', maxlength: 60, required: true })),
        h('label', {}, 'Year', select('year', YEARS.map(y => [y, y])))),
      h('div', { class: 'two' },
        h('label', {}, 'Show ages from', h('input', { name: 'min_age', type: 'number', min: 18, max: 40, value: 18, required: true })),
        h('label', {}, 'To age', h('input', { name: 'max_age', type: 'number', min: 18, max: 40, value: 30, required: true }))),
      h('label', {}, 'Profile photos (up to 6, optional)', photoInput, h('span', { class: 'hint' }, 'Photos are resized automatically for your profile.')),
      h('label', {}, 'Interests (comma separated)', h('input', { name: 'interests', maxlength: 220, placeholder: 'music, hiking, chai' })),
      h('label', {}, 'Hobbies (comma separated)', h('input', { name: 'hobbies', maxlength: 260, placeholder: 'photography, football, baking' })),
      h('p', { class: 'hint' }, 'Browse profiles from anywhere.'),
      h('label', {}, 'About you', h('textarea', { name: 'bio', maxlength: 400, placeholder: 'Your favourite canteen order, what you are studying, what you want to talk about.' })),
      h('label', { class: 'check' }, h('input', { name: 'agreed', type: 'checkbox', required: true }),
        'I am 18 or older. I will be respectful, use my real details, and meet in public places first.'),
      err,
      h('button', { class: 'btn primary', type: 'submit' }, 'Create your profile'),
      h('p', { class: 'hint' }, 'Already have an account? ', h('a', { href: '#/login' }, 'Log in')));
    shell(h('div', {}, h('h2', {}, 'Create your profile'), social, form));
    googleSignIn(social);
  }

  // ---------- discover ----------
  function idCard(u) {
    const tags = [...(u.shared_interests?.length ? u.shared_interests : u.interests || []), ...(u.hobbies || [])].slice(0, 4);
    return h('article', { class: 'idcard' },
      h('div', { class: 'card-photo-stage' },
        (u.photos?.[0] || u.photo) ? h('img', { class: 'profile-photo', src: u.photos?.[0] || u.photo, alt: u.name + ' profile photo' }) : h('div', { class: 'avatar', style: 'background:' + colorFor(u.id), 'aria-hidden': 'true' }, initial(u)),
        h('span', { class: 'campus-pill' }, '✦  ' + u.college),
        h('div', { class: 'card-caption' },
          h('h2', {}, u.name, ' ', h('span', {}, u.age)),
          h('p', {}, u.year + ' · ' + u.city))),
      h('div', { class: 'idcard-body' },
        h('p', { class: 'bio' }, u.bio || 'Still writing their story.'),
        h('div', { class: 'interest-pills' }, tags.map(i => h('span', {}, i))),
        u.star_sign ? h('span', { class: 'card-zodiac' }, '✧ ' + u.star_sign) : null));
  }

  async function viewDiscover() {
    const holder = h('div', {});
    shell(h('div', { class: 'page discover-page' },
      h('div', { class: 'page-heading' }, h('div', {}, h('span', { class: 'eyebrow' }, 'YOUR CAMPUS, OPENED UP'), h('h1', {}, 'Discover')),
        h('p', {}, 'Take your time. Your next great conversation could be one swipe away.')),
      holder), 'discover');
    let busy = false;

    async function load() {
      const r = await api('GET', '/discover');
      state.cards = r.cards;
    }

    function paint() {
      holder.replaceChildren();
      const u = state.cards[0];
      if (!u) {
        holder.append(h('div', { class: 'empty' },
          h('h2', {}, 'No new profiles right now'),
          h('p', {}, 'You have seen everyone for now. Check again later as more students join.'),
          h('button', { class: 'btn', type: 'button', onclick: refresh }, 'Check again')));
        return;
      }
      const card = idCard(u);
      let down = null;
      card.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; card.setPointerCapture(e.pointerId); });
      card.addEventListener('pointerup', e => {
        if (!down) return;
        const dx = e.clientX - down.x, dy = e.clientY - down.y; down = null;
        if (Math.abs(dx) > 75 && Math.abs(dx) > Math.abs(dy) * 1.2) swipe(dx > 0);
      });
      holder.append(
        h('div', { class: 'deck' }, card),
        h('div', { class: 'actions' },
          h('button', { class: 'btn', type: 'button', onclick: () => swipe(false) }, 'Pass'),
          h('button', { class: 'btn like', type: 'button', onclick: () => swipe(true) }, 'Like')));
    }

    async function refresh() {
      try { await load(); } catch (e) { toast(e.message); }
      paint();
    }

    async function swipe(like) {
      if (busy || !state.cards.length) return;
      busy = true;
      const u = state.cards[0];
      try {
        const r = await api('POST', '/swipe', { to: u.id, like });
        state.cards.shift();
        if (r.match) showMatch(r.match);
        if (state.cards.length < 3) { try { const more = await api('GET', '/discover'); const have = new Set(state.cards.map(c => c.id)); state.cards.push(...more.cards.filter(c => !have.has(c.id))); } catch {} }
      } catch (e) { toast(e.message); }
      busy = false;
      paint();
    }

    await refresh();
  }

  function showMatch(match) {
    const close = () => ov.remove();
    const ov = h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'New match' },
      h('div', { class: 'box' },
        h('h2', {}, 'It is a match'),
        h('p', {}, 'You and ' + match.user.name + ' liked each other.'),
        h('a', { class: 'btn primary', href: '#/chat/' + match.id, onclick: close }, 'Send a message'),
        h('button', { class: 'btn', type: 'button', onclick: close }, 'Keep swiping')));
    document.body.append(ov);
  }

  async function viewLikes() {
    const holder = h('div', { class: 'likes-grid' });
    shell(h('div', { class: 'page' },
      h('div', { class: 'page-heading' }, h('div', {}, h('span', { class: 'eyebrow' }, 'A LITTLE FLATTERING, RIGHT?'), h('h1', {}, 'Likes you')),
        h('p', {}, 'People who have already made the first move.')),
      holder), 'likes');
    async function refresh() {
      try {
        const r = await api('GET', '/likes');
        holder.replaceChildren();
        if (!r.cards.length) {
          holder.append(h('div', { class: 'empty-card' }, h('span', { class: 'empty-icon' }, '♡'), h('h2', {}, 'Your likes will show up here'),
            h('p', {}, 'Keep your profile feeling like you. The right people are out there.'), h('a', { class: 'btn primary', href: '#/discover' }, 'Back to discover')));
          return;
        }
        for (const u of r.cards) {
          const card = idCard(u); card.classList.add('liked-card');
          const actions = h('div', { class: 'like-card-actions' },
            h('button', { class: 'round-action pass-action', type: 'button', 'aria-label': 'Pass on ' + u.name, onclick: () => decide(u, false) }, '×'),
            h('button', { class: 'round-action like-action', type: 'button', 'aria-label': 'Like ' + u.name, onclick: () => decide(u, true) }, '♡'));
          holder.append(h('div', { class: 'like-card-wrap' }, card, actions));
        }
      } catch (e) { holder.append(h('p', { class: 'error' }, e.message)); }
    }
    async function decide(user, like) {
      try {
        const r = await api('POST', '/swipe', { to: user.id, like });
        if (r.match) showMatch(r.match);
        await refresh();
      } catch (e) { toast(e.message); }
    }
    await refresh();
  }

  // ---------- matches ----------
  const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

  async function viewMatches() {
    const holder = h('div', { class: 'page' }, h('div', { class: 'page-heading' }, h('div', {}, h('span', { class: 'eyebrow' }, 'THE START OF SOMETHING'), h('h1', {}, 'Your matches')),
      h('p', {}, 'Good chemistry deserves a good conversation.')));
    shell(holder, 'matches');
    try {
      const r = await api('GET', '/matches');
      state.matches = r.matches;
      if (!r.matches.length) {
        holder.append(h('div', { class: 'empty-card' }, h('span', { class: 'empty-icon' }, '✦'), h('h2', {}, 'Your story starts with a match'), h('p', {}, 'When you and someone like each other, you’ll find them here.'),
          h('a', { class: 'btn primary', href: '#/discover' }, 'Start swiping')));
        return;
      }
      holder.append(h('div', { class: 'conversations-heading' }, h('h2', {}, 'Conversations'), h('span', {}, r.matches.length + ' connection' + (r.matches.length === 1 ? '' : 's'))),
        h('div', { class: 'list' }, r.matches.map(m =>
          h('a', { class: 'item', href: '#/chat/' + m.match_id },
            m.user.photos?.[0] || m.user.photo ? h('img', { class: 'conversation-avatar', src: m.user.photos?.[0] || m.user.photo, alt: '' }) : h('span', { class: 'dot', style: 'background:' + colorFor(m.user.id), 'aria-hidden': 'true' }, initial(m.user)),
            h('span', { class: 'conversation-copy' }, h('b', {}, m.user.name), h('small', {},
              m.last_message ? (m.last_message.mine ? 'You: ' : '') + m.last_message.body.slice(0, 60) : 'Say hi to ' + m.user.name)),
            h('span', { class: 'conversation-arrow' }, '↗')))));
    } catch (e) { holder.append(h('p', { class: 'error' }, e.message)); }
  }

  // ---------- chat ----------
  async function viewChat(id) {
    if (!state.matches.length) { try { state.matches = (await api('GET', '/matches')).matches; } catch {} }
    const m = state.matches.find(x => x.match_id === Number(id));
    if (!m) { toast('That conversation is not available.'); location.hash = '#/matches'; return; }

    const list = h('div', { class: 'messages', 'aria-live': 'polite' });
    const seen = new Set();
    let lastId = 0, stopped = false, timer = null, live = null;

    function add(msgs) {
      let added = false;
      for (const x of msgs) {
        if (seen.has(x.id)) continue;
        seen.add(x.id); added = true;
        lastId = Math.max(lastId, x.id);
        list.append(h('div', { class: 'msg' + (x.mine ? ' mine' : ''), title: timeFmt.format(new Date(x.at)) }, x.body));
      }
      if (added) window.scrollTo(0, document.body.scrollHeight);
    }

    async function poll() {
      try { const r = await api('GET', `/matches/${id}/messages?after=${lastId}`); if (!stopped) add(r.messages); }
      catch (e) { if (e.status === 403 || e.status === 404) { stopped = true; toast(e.message); location.hash = '#/matches'; } }
    }

    async function block() {
      if (!confirm('Block ' + m.user.name + '? You will not see each other again.')) return;
      try { await api('POST', '/block', { user: m.user.id }); state.matches = []; location.hash = '#/matches'; } catch (e) { toast(e.message); }
    }
    async function report() {
      const reason = prompt('What happened? We will also block ' + m.user.name + ' for you.');
      if (!reason || !reason.trim()) return;
      try { await api('POST', '/report', { user: m.user.id, reason }); toast('Reported and blocked.'); state.matches = []; location.hash = '#/matches'; } catch (e) { toast(e.message); }
    }

    const input = h('input', { name: 'body', maxlength: 1000, placeholder: 'Write a message', autocomplete: 'off', 'aria-label': 'Message', required: true });
    const form = h('form', { onsubmit: async (e) => {
      e.preventDefault();
      const body = input.value.trim();
      if (!body) return;
      input.value = '';
      try {
        if (live?.readyState === WebSocket.OPEN) live.send(JSON.stringify({ body }));
        else { const r = await api('POST', `/matches/${id}/messages`, { body }); add([r.message]); }
      }
      catch (ex) { input.value = body; toast(ex.message); }
    } }, input, h('button', { class: 'btn primary', type: 'submit' }, 'Send'));

    shell(h('div', { class: 'chat-page' },
      h('div', { class: 'chat-head' },
        h('a', { class: 'btn small', href: '#/matches' }, 'Back'),
        h('h2', {}, m.user.name),
        h('span', { style: 'flex:1' }),
        h('button', { class: 'btn small', type: 'button', onclick: block }, 'Block'),
        h('button', { class: 'btn small', type: 'button', onclick: report }, 'Report')),
      h('p', { class: 'hint' }, 'Meet in a public place first and tell a friend where you are going.'),
      list,
      h('div', { class: 'send' }, form)), 'matches');

    await poll();
    const startFallback = () => { if (!stopped && !timer) timer = setInterval(poll, 3000); };
    try {
      const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
      live = new WebSocket(`${scheme}//${location.host}/ws?token=${encodeURIComponent(state.token)}&match=${encodeURIComponent(id)}`);
      live.addEventListener('message', event => {
        try { const data = JSON.parse(event.data); if (data.type === 'message') add([data.message]); } catch {}
      });
      live.addEventListener('open', () => { if (timer) { clearInterval(timer); timer = null; } });
      live.addEventListener('close', startFallback);
      live.addEventListener('error', () => live.close());
    } catch { startFallback(); }
    cleanup = () => { stopped = true; if (timer) clearInterval(timer); live?.close(); };
  }

  async function viewProfile() {
    const wrap = h('div', { class: 'page profile-page' },
      h('div', { class: 'page-heading' }, h('div', {}, h('span', { class: 'eyebrow' }, 'YOUR SPACE'), h('h1', {}, 'Your profile')),
        h('p', {}, 'This is how you show up in the CampusMatch community.')));
    shell(wrap, 'profile');
    try {
      const user = (await api('GET', '/me')).user;
      const photos = user.photos?.length ? user.photos : (user.photo ? [user.photo] : []);
      let mainPhoto;
      if (photos.length) mainPhoto = h('img', { class: 'profile-cover-photo', src: photos[0], alt: user.name + ' profile photo' });
      else mainPhoto = h('div', { class: 'profile-cover-placeholder', style: 'background:' + colorFor(user.id) }, initial(user));
      const thumbRow = h('div', { class: 'profile-thumbnails' });
      photos.slice(0, 6).forEach((src, index) => thumbRow.append(h('button', {
        class: 'profile-thumb' + (index === 0 ? ' selected' : ''), type: 'button', 'aria-label': 'Show photo ' + (index + 1), onclick: () => {
          const replacement = h('img', { class: 'profile-cover-photo', src, alt: user.name + ' profile photo' });
          mainPhoto.replaceWith(replacement); mainPhoto = replacement;
          thumbRow.querySelectorAll('.profile-thumb').forEach((el, i) => el.classList.toggle('selected', i === index));
        },
      }, h('img', { src, alt: '' }))));
      const genderNames = { woman: 'Woman', man: 'Man', nonbinary: 'Non-binary' };
      const lookingNames = { women: 'Women', men: 'Men', everyone: 'Everyone' };
      const zodiacIcons = { Aries: '♈', Taurus: '♉', Gemini: '♊', Cancer: '♋', Leo: '♌', Virgo: '♍', Libra: '♎', Scorpio: '♏', Sagittarius: '♐', Capricorn: '♑', Aquarius: '♒', Pisces: '♓' };
      const infoGrid = h('div', { class: 'profile-info-grid' },
        h('div', { class: 'profile-info-tile' }, h('span', { class: 'info-icon' }, '⌂'), h('div', {}, h('small', {}, 'COLLEGE'), h('b', {}, user.college))),
        h('div', { class: 'profile-info-tile' }, h('span', { class: 'info-icon' }, '⌖'), h('div', {}, h('small', {}, 'CITY'), h('b', {}, user.city))),
        h('div', { class: 'profile-info-tile' }, h('span', { class: 'info-icon' }, '✎'), h('div', {}, h('small', {}, 'STUDY YEAR'), h('b', {}, user.year))),
        h('div', { class: 'profile-info-tile' }, h('span', { class: 'info-icon' }, '♡'), h('div', {}, h('small', {}, 'GENDER'), h('b', {}, genderNames[user.gender] || user.gender))),
        h('div', { class: 'profile-info-tile' }, h('span', { class: 'info-icon' }, zodiacIcons[user.star_sign] || '✧'), h('div', {}, h('small', {}, 'STAR SIGN'), h('b', {}, user.star_sign || 'Not available'))));
      const interests = user.interests?.length
        ? h('div', { class: 'profile-interest-list' }, user.interests.map((interest, index) => h('span', {}, ['✦', '♪', '⌁', '♡'][index % 4] + '  ' + interest)))
        : h('p', { class: 'profile-muted' }, 'Add a few interests to help people find something to talk about.');
      const hobbies = user.hobbies?.length
        ? h('div', { class: 'profile-interest-list hobby-list' }, user.hobbies.map((hobby, index) => h('span', {}, ['◌', '↗', '⌂', '✿'][index % 4] + '  ' + hobby)))
        : h('p', { class: 'profile-muted' }, 'Add the things you love doing in your free time.');
      const preview = h('section', { class: 'profile-preview' },
        h('div', { class: 'profile-photo-column' },
          h('div', { class: 'profile-cover' }, mainPhoto, h('span', { class: 'photo-count' }, photos.length ? (photos.length + ' PHOTO' + (photos.length === 1 ? '' : 'S')) : 'ADD A PHOTO')),
          photos.length > 1 ? thumbRow : null),
        h('div', { class: 'profile-details' },
          h('div', { class: 'profile-name-row' }, h('div', {}, h('span', { class: 'eyebrow' }, 'CAMPUSMATCH MEMBER'), h('h2', {}, user.name, ' ', user.age), h('p', { class: 'profile-subtitle' }, (genderNames[user.gender] || user.gender) + ' · ' + user.college)),
            h('span', { class: 'profile-heart' }, '♡')),
          h('section', { class: 'profile-section' }, h('h3', {}, 'A little about me'), h('p', { class: 'profile-bio' }, user.bio || 'Add a short bio to introduce yourself.')),
          h('section', { class: 'profile-section' }, h('h3', {}, 'A few details'), infoGrid),
          h('section', { class: 'profile-section' }, h('h3', {}, 'Interests'), interests),
          h('section', { class: 'profile-section' }, h('h3', {}, 'Hobbies'), hobbies),
          h('section', { class: 'preference-summary' }, h('span', { class: 'eyebrow' }, 'MY DISCOVERY SETTINGS'),
            h('p', {}, 'Looking for ', h('b', {}, lookingNames[user.interested_in] || 'Everyone'), ' · ages ', h('b', {}, user.min_age + '–' + user.max_age)),
            h('small', {}, 'Browse profiles from anywhere.')),
          h('a', { class: 'btn primary profile-edit-button', href: '#/profile/edit' }, 'Edit profile', h('span', {}, '↗'))));
      wrap.append(preview);
    } catch (e) { wrap.append(h('p', { class: 'error' }, e.message)); }
  }

  async function viewEditProfile() {
    const wrap = h('div', { class: 'page profile-page' }, h('div', { class: 'page-heading' }, h('div', {}, h('span', { class: 'eyebrow' }, 'MAKE IT YOURS'), h('h1', {}, 'Edit profile')),
      h('p', {}, 'Update your photos, details, and who you want to meet.')),
      h('a', { class: 'text-link profile-back-link', href: '#/profile' }, '← Back to profile'));
    shell(wrap, 'profile');
    try {
      const user = (await api('GET', '/me')).user;
      const err = h('p', { class: 'error', role: 'alert' });
      const photoInput = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', multiple: true });
      let photos = user.photos?.length ? user.photos : (user.photo ? [user.photo] : []);
      photoInput.addEventListener('change', async () => {
        const files = [...(photoInput.files || [])];
        if (files.length > 6) { photoInput.value = ''; toast('Choose up to six photos.'); return; }
        try { photos = await Promise.all(files.map(optimizePhoto)); }
        catch (e) { photoInput.value = ''; toast(e.message); }
      });
      const field = (label, name, value, attrs = {}) => h('label', {}, label, h('input', { name, value, ...attrs }));
      const select = (label, name, options, value) => h('label', {}, label, h('select', { name }, options.map(([v, text]) => h('option', { value: v, selected: v === value }, text))));
      const form = h('form', { class: 'stack', onsubmit: async e => {
        e.preventDefault(); err.textContent = '';
        const f = form.elements;
        try {
          const r = await api('PUT', '/me', { name: f.name.value, gender: f.gender.value, interested_in: f.interested_in.value,
            college: f.college.value, city: f.city.value, year: f.year.value, bio: f.bio.value,
            min_age: f.min_age.value, max_age: f.max_age.value,
            interests: f.interests.value.split(',').map(s => s.trim()).filter(Boolean),
            hobbies: f.hobbies.value.split(',').map(s => s.trim()).filter(Boolean), photos });
          state.user = r.user; toast('Profile saved.'); location.hash = '#/profile';
        } catch (ex) { err.textContent = ex.message; }
      } },
        field('Name', 'name', user.name, { maxlength: 50, required: true }),
        select('I am', 'gender', [['woman','A woman'],['man','A man'],['nonbinary','Non-binary']], user.gender),
        select('Show me', 'interested_in', [['everyone','Everyone'],['women','Women'],['men','Men']], user.interested_in),
        field('College', 'college', user.college, { maxlength: 100, required: true }),
        h('div', { class: 'two' }, field('City', 'city', user.city, { maxlength: 60, required: true }), field('Year', 'year', user.year, { maxlength: 30, required: true })),
        h('div', { class: 'two' }, field('Minimum age', 'min_age', user.min_age, { type: 'number', min: 18, max: 40, required: true }), field('Maximum age', 'max_age', user.max_age, { type: 'number', min: 18, max: 40, required: true })),
        h('label', {}, 'Profile photos (up to 6)', photoInput, h('span', { class: 'hint' }, 'Selecting new photos replaces the current gallery. They are resized automatically.')),
        field('Interests (comma separated)', 'interests', (user.interests || []).join(', '), { maxlength: 220 }),
        field('Hobbies (comma separated)', 'hobbies', (user.hobbies || []).join(', '), { maxlength: 260 }),
        h('label', {}, 'About you', h('textarea', { name: 'bio', maxlength: 400 }, user.bio || '')),
        h('p', { class: 'hint' }, 'Browse profiles from anywhere.'),
        err, h('button', { class: 'btn primary', type: 'submit' }, 'Save profile'));
      wrap.append(form);
    } catch (e) { wrap.append(h('p', { class: 'error' }, e.message)); }
  }

  // ---------- router ----------
  function route() {
    if (cleanup) { cleanup(); cleanup = null; }
    const hashRoute = location.hash.replace(/^#/, '');
    const [routePath, routeQuery = ''] = hashRoute.split('?');
    const parts = routePath.split('/').filter(Boolean);
    if (parts[0] === 'reset-password') { const token = new URLSearchParams(routeQuery).get('token') || ''; return viewResetPassword(token); }
    if (parts[0] === 'forgot-password') return viewForgotPassword();
    if (!state.user) {
      if (parts[0] === 'login') return viewLogin();
      if (parts[0] === 'signup') return viewSignup();
      return viewLanding();
    }
    if (parts[0] === 'matches') return viewMatches();
    if (parts[0] === 'likes') return viewLikes();
    if (parts[0] === 'chat') return viewChat(parts[1]);
    if (parts[0] === 'profile' && parts[1] === 'edit') return viewEditProfile();
    if (parts[0] === 'profile') return viewProfile();
    return viewDiscover();
  }

  window.addEventListener('hashchange', route);

  (async () => {
    if (state.token) {
      try { state.user = (await api('GET', '/me')).user; } catch { clearSession(); }
    }
    route();
  })();
})();
