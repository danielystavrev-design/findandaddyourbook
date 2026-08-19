const elements = {
  isbnInput: document.querySelector('#isbn-input'),
  lookupButton: document.querySelector('#lookup-button'),
  cameraButton: document.querySelector('#camera-button'),
  resultSection: document.querySelector('#result-section'),
  resultTemplate: document.querySelector('#result-template'),
  libraryList: document.querySelector('#library-list'),
  emptyLibrary: document.querySelector('#empty-library'),
  clearLibrary: document.querySelector('#clear-library'),
  viewCardsButton: document.querySelector('#view-cards'),
  viewSheetButton: document.querySelector('#view-sheet'),
  exportXlsxButton: document.querySelector('#export-xlsx'),
  exportCsvButton: document.querySelector('#export-csv'),
  locationFilter: document.querySelector('#location-filter'),
  defaultPlace: document.querySelector('#default-place'),
  cameraDialog: document.querySelector('#camera-dialog'),
  cameraVideo: document.querySelector('#camera-video'),
  cameraStatus: document.querySelector('#camera-status'),
  connectionPill: document.querySelector('#connection-pill'),
  openAccountButton: document.querySelector('#open-account'),
  accountDialog: document.querySelector('#account-dialog'),
  accountSignedOut: document.querySelector('#account-signed-out'),
  accountSignedIn: document.querySelector('#account-signed-in'),
  accountEmailInput: document.querySelector('#account-email'),
  accountPasswordInput: document.querySelector('#account-password'),
  accountError: document.querySelector('#account-error'),
  accountEmailDisplay: document.querySelector('#account-email-display'),
};

const storage = {
  get books() { return JSON.parse(localStorage.getItem('bookdrop:books') || '[]'); },
  set books(books) { localStorage.setItem('bookdrop:books', JSON.stringify(books)); },
  // Books confirmed once (by search or manual entry) are kept here so the
  // same ISBN is recognised instantly on every future scan.
  get catalogue() { return JSON.parse(localStorage.getItem('bookdrop:catalogue') || '{}'); },
  set catalogue(entries) { localStorage.setItem('bookdrop:catalogue', JSON.stringify(entries)); },
  get libraryView() { return localStorage.getItem('bookdrop:library-view') || 'cards'; },
  set libraryView(view) { localStorage.setItem('bookdrop:library-view', view); },
  // Names of the physical places books live in — "Hallway, top shelf",
  // "Bedroom", "Box in the cellar". Kept separately from the books so a place
  // can exist before anything is shelved there, and survives emptying a shelf.
  get locations() { return JSON.parse(localStorage.getItem('bookdrop:locations') || '[]'); },
  set locations(names) { localStorage.setItem('bookdrop:locations', JSON.stringify(names)); },
  get locationFilter() { return localStorage.getItem('bookdrop:location-filter') || ''; },
  set locationFilter(value) { localStorage.setItem('bookdrop:location-filter', value); },
  // The place newly found books are shelved into by default, so a whole
  // bookcase can be scanned in one go without re-picking it every time.
  get defaultLocation() { return localStorage.getItem('bookdrop:default-location') || ''; },
  set defaultLocation(value) { localStorage.setItem('bookdrop:default-location', value); },
};

// --- Copies -------------------------------------------------------------

// A book record holds every physical copy the person owns, each with its own
// place. Older records predate this and carry a single flat `location`, so
// they're presented as a one-copy book rather than migrated destructively.
function bookCopies(book) {
  if (Array.isArray(book.copies) && book.copies.length) return book.copies;
  return [{ location: book.location || '', addedAt: book.addedAt }];
}

function copyCount(book) {
  return bookCopies(book).length;
}

// --- Physical locations -------------------------------------------------

// The authoritative list is the union of places the person has named and
// places actually in use by a copy. Deriving the second half means a
// signed-in collection carries its locations across devices for free,
// without needing a second Firestore collection to keep in sync.
function knownLocations() {
  const used = currentLibraryBooks.flatMap(book =>
    bookCopies(book).map(copy => copy.location)).filter(Boolean);
  return [...new Set([...storage.locations, ...used])].sort((a, b) => a.localeCompare(b));
}

function rememberLocation(name) {
  const clean = (name || '').trim();
  if (!clean) return '';
  if (!storage.locations.includes(clean)) storage.locations = [...storage.locations, clean];
  return clean;
}

const NEW_LOCATION_VALUE = '__new__';

// The picker in the scan card. Whatever is chosen here becomes the place a
// newly found book is offered under, which is what makes shelving a stack of
// books practical: set it once, then keep scanning.
function renderDefaultPlacePicker() {
  const host = elements.defaultPlace;
  if (!host) return;
  // A Firestore update can land at any moment; repainting mid-typing would
  // silently discard a name the person is still writing.
  if (host.contains(document.activeElement)
      && document.activeElement.classList.contains('location-new-input')) return;
  const picker = buildLocationPicker(storage.defaultLocation, {
    label: 'Add scanned books to',
  });
  const commit = value => {
    storage.defaultLocation = value;
    if (value) renderDefaultPlacePicker();   // repaint so a new name appears listed
  };
  picker.element.querySelector('.location-select').addEventListener('change', event => {
    if (event.target.value !== NEW_LOCATION_VALUE) commit(event.target.value);
  });
  const input = picker.element.querySelector('.location-new-input');
  input.addEventListener('keydown', event => { if (event.key === 'Enter') commit(picker.value()); });
  input.addEventListener('blur', () => { const v = picker.value(); if (v) commit(v); });
  host.replaceChildren(picker.element);
}

// Builds a <select> of known places plus an "add a new one" escape hatch.
// Returns a function that reads the currently chosen place, so callers don't
// have to care whether it came from the dropdown or the free-text field.
function buildLocationPicker(selected = '', { label = 'Where is this book kept?' } = {}) {
  const wrapper = document.createElement('div');
  wrapper.className = 'location-picker';
  const select = document.createElement('select');
  select.className = 'location-select';
  select.setAttribute('aria-label', label);
  const input = document.createElement('input');
  input.className = 'location-new-input hidden';
  input.type = 'text';
  input.placeholder = 'Name this place, e.g. Bedroom, middle shelf';
  input.setAttribute('aria-label', 'Name of the new place');

  const paint = () => {
    const places = knownLocations();
    select.replaceChildren();
    const blank = new Option('No place set', '');
    select.append(blank);
    places.forEach(place => select.append(new Option(place, place)));
    select.append(new Option('+ Add a new place…', NEW_LOCATION_VALUE));
    select.value = places.includes(selected) ? selected : '';
  };
  paint();

  select.addEventListener('change', () => {
    const adding = select.value === NEW_LOCATION_VALUE;
    input.classList.toggle('hidden', !adding);
    if (adding) input.focus();
  });

  const labelEl = document.createElement('span');
  labelEl.className = 'location-label';
  labelEl.textContent = label;
  wrapper.append(labelEl, select, input);

  return {
    element: wrapper,
    // Commits a brand-new name to the saved list the moment it's read.
    value() {
      if (select.value === NEW_LOCATION_VALUE) return rememberLocation(input.value);
      return select.value;
    },
  };
}

let activeBook = null;
let activeLocationPicker = null;
let cameraStream = null;
let scanTimer = null;
let toastTimer = null;
let zxingControls = null;
let bookArchive = {};

// Loaded once at startup: a large ISBN-keyed catalogue of Bulgarian editions
// (from the uploaded Book-archive-Knigohodets file) so those titles are
// recognised instantly, without depending on Google Books/Open Library.
async function loadBookArchive() {
  try {
    const response = await fetch('./book-archive.json');
    if (!response.ok) return;
    bookArchive = await response.json();
    updateConnectionState();
  } catch (error) {
    // Archive is an enhancement, not a requirement — silently continue without it.
  }
}

// --- Accounts (optional) -----------------------------------------------
// Fill this in once with your own Firebase project's config to turn on
// email accounts, so each person's collection follows them across devices
// instead of staying in one browser. Leave the placeholder as-is to keep
// running in local-only (no accounts) mode.
//
// Get this object from: Firebase Console → Project settings → your web app.
const firebaseConfig = {
  apiKey: 'AIzaSyC2Y7uog9ooSsIa1US6aY1hxwBZvlyUW3w',
  authDomain: 'dropbook-87ede.firebaseapp.com',
  projectId: 'dropbook-87ede',
  storageBucket: 'dropbook-87ede.firebasestorage.app',
  messagingSenderId: '360087135397',
  appId: '1:360087135397:web:174b43278e02935e37594c',
  measurementId: 'G-0ZJCRV3H4W',
};

// Paste these into Firebase Console → Firestore Database → Rules, so every
// account can only ever read or write its own books:
//
// rules_version = '2';
// service cloud.firestore {
//   match /databases/{database}/documents {
//     match /users/{userId}/books/{bookId} {
//       allow read, write: if request.auth != null && request.auth.uid == userId;
//     }
//   }
// }

let auth = null;
let db = null;
let currentUser = null;
let firebaseReady = false;
let libraryUnsubscribe = null;
let currentLibraryBooks = [];

if (window.firebase && firebaseConfig.apiKey && firebaseConfig.apiKey !== 'YOUR_API_KEY') {
  firebase.initializeApp(firebaseConfig);
  auth = firebase.auth();
  db = firebase.firestore();
  firebaseReady = true;
}

// Regional editions are often absent from Google Books and Open Library. This
// small local catalogue provides verified records while the collection grows.
const regionalEditionCache = {
  '9786197339284': {
    title: 'Ана Ана: Гребен за Космато топче',
    authors: 'Алекси Дормал, Доминик Рок',
    published: '2022',
    publisher: 'Пурко',
    description: 'Ана Ана иска да направи прическа на някоя плюшка. Честта се пада на Космато топче.',
    cover: '',
    source: 'Regional catalogue',
  },
};

function normalizeIsbn(value) {
  return value.replace(/[^0-9Xx]/g, '').toUpperCase();
}

function isValidIsbn13(value) {
  if (!/^\d{13}$/.test(value)) return false;
  const total = [...value].slice(0, 12).reduce((sum, digit, index) => sum + Number(digit) * (index % 2 ? 3 : 1), 0);
  return (10 - (total % 10)) % 10 === Number(value[12]);
}

function isValidIsbn10(value) {
  if (!/^\d{9}[\dX]$/.test(value)) return false;
  return [...value].reduce((sum, digit, index) => sum + (digit === 'X' ? 10 : Number(digit)) * (10 - index), 0) % 11 === 0;
}

function isbnCandidates(value) {
  const scannedValue = normalizeIsbn(value);
  const candidates = new Set();
  const addIfValid = candidate => {
    if ((candidate.length === 13 && isValidIsbn13(candidate)) || (candidate.length === 10 && isValidIsbn10(candidate))) {
      candidates.add(candidate);
    }
  };

  // Some scanners include a GTIN-14 packing prefix or a 2-/5-digit price add-on.
  // Extract any valid ISBN embedded in that scanned value instead of querying the full barcode.
  [scannedValue, scannedValue.replace(/^00/, '')].forEach(candidate => {
    addIfValid(candidate);
    for (let index = 0; index <= candidate.length - 13; index += 1) addIfValid(candidate.slice(index, index + 13));
    for (let index = 0; index <= candidate.length - 10; index += 1) addIfValid(candidate.slice(index, index + 10));
  });
  return [...candidates];
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function bookCover(book) {
  return book.cover || `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="240"><rect width="100%" height="100%" fill="#e9e1cf"/><path d="M35 30h90v180H35z" fill="#31503d"/><path d="M47 49h66M47 66h50M47 144h66" stroke="#ead8aa" stroke-width="4"/><text x="80" y="198" fill="#ead8aa" text-anchor="middle" font-family="serif" font-size="17">BOOK</text></svg>`)}`;
}

function cobissSearchUrl(isbn) {
  return `https://plus.cobiss.net/cobiss/bg/bg/bib/search?q=${encodeURIComponent(isbn)}&db=cobib`;
}

function goodreadsSearchUrl(book) {
  return `https://www.goodreads.com/search?q=${encodeURIComponent(book.isbn || [book.title, book.authors].filter(Boolean).join(' '))}`;
}

function setLookupLoading(isLoading) {
  elements.lookupButton.disabled = isLoading;
  elements.lookupButton.innerHTML = isLoading ? 'Searching…' : 'Find book <span aria-hidden="true">→</span>';
}

function showToast(message) {
  let toast = document.querySelector('.toast');
  if (!toast) { toast = document.createElement('div'); toast.className = 'toast'; document.body.append(toast); }
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3200);
}

function updateConnectionState() {
  const archiveCount = Object.keys(bookArchive).length;
  const signedIn = Boolean(currentUser);
  elements.connectionPill.classList.toggle('connected', signedIn);
  elements.connectionPill.innerHTML = signedIn
    ? '<i></i> Synced to your account'
    : archiveCount > 0
      ? `<i></i> Local collection · ${archiveCount.toLocaleString()} archive titles`
      : '<i></i> Local collection';
}

// Switches the collection between a signed-in account (live Firestore data,
// synced across devices) and this browser's local storage (guest mode).
function attachLibrarySource() {
  libraryUnsubscribe?.();
  libraryUnsubscribe = null;
  if (currentUser && firebaseReady) {
    libraryUnsubscribe = db.collection('users').doc(currentUser.uid).collection('books').orderBy('addedAt', 'desc')
      .onSnapshot(snapshot => {
        currentLibraryBooks = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        renderLibrary();
      }, () => showToast('Could not load your saved collection.'));
  } else {
    currentLibraryBooks = storage.books;
    renderLibrary();
  }
}

function updateAccountUI() {
  elements.accountSignedOut.classList.toggle('hidden', Boolean(currentUser));
  elements.accountSignedIn.classList.toggle('hidden', !currentUser);
  elements.accountEmailDisplay.textContent = currentUser?.email || '';
  elements.openAccountButton.classList.toggle('connected', Boolean(currentUser));
  elements.openAccountButton.title = currentUser ? `Account: ${currentUser.email}` : 'Sign in or create an account';
}

function showAccountError(message) {
  elements.accountError.textContent = message;
  elements.accountError.classList.remove('hidden');
}

function authErrorMessage(error) {
  const messages = {
    'auth/email-already-in-use': 'An account with that email already exists — try signing in instead.',
    'auth/invalid-email': 'That email address looks invalid.',
    'auth/weak-password': 'Use a password with at least 6 characters.',
    'auth/wrong-password': 'Incorrect password.',
    'auth/user-not-found': 'No account found with that email.',
    'auth/invalid-credential': 'Incorrect email or password.',
    'auth/too-many-requests': 'Too many attempts. Please try again shortly.',
    // Someone registered with a password first, then returned via Google.
    'auth/account-exists-with-different-credential':
      'You already have an account with that email. Sign in with your password instead.',
    'auth/popup-closed-by-user': 'Sign-in was cancelled.',
    'auth/cancelled-popup-request': 'Sign-in was cancelled.',
    'auth/unauthorized-domain':
      'This site is not authorised for Google sign-in yet. Add its domain in the Firebase console.',
    'auth/operation-not-allowed':
      'Google sign-in is not enabled for this project yet.',
  };
  return messages[error.code] || 'Something went wrong. Please try again.';
}

// Google sign-in. A popup is tried first because it keeps the person on the
// page; when the browser blocks it — common on iOS — we fall back to a full
// redirect, whose result is picked up on the next load.
async function handleGoogleSignIn() {
  elements.accountError.classList.add('hidden');
  if (!firebaseReady) { showAccountError('Accounts are not set up on this site yet.'); return; }

  const provider = new firebase.auth.GoogleAuthProvider();
  // Always ask which account to use; otherwise a shared device silently
  // reuses whoever signed in last.
  provider.setCustomParameters({ prompt: 'select_account' });

  try {
    const credential = await auth.signInWithPopup(provider);
    elements.accountDialog.close();
    await migrateLocalBooksToAccount(credential.user);
  } catch (error) {
    const popupUnavailable = [
      'auth/popup-blocked',
      'auth/operation-not-supported-in-this-environment',
      'auth/web-storage-unsupported',
    ].includes(error.code);
    if (popupUnavailable) {
      try {
        await auth.signInWithRedirect(provider);
        return;                       // the page navigates away from here
      } catch (redirectError) {
        showAccountError(authErrorMessage(redirectError));
        return;
      }
    }
    if (error.code === 'auth/popup-closed-by-user' ||
        error.code === 'auth/cancelled-popup-request') return;   // deliberate, not an error
    showAccountError(authErrorMessage(error));
  }
}

async function handleAuthAction(mode) {
  elements.accountError.classList.add('hidden');
  if (!firebaseReady) { showAccountError('Accounts are not set up on this site yet.'); return; }
  const email = elements.accountEmailInput.value.trim();
  const password = elements.accountPasswordInput.value.trim();
  if (!email || !password) { showAccountError('Enter both an email and a password.'); return; }
  try {
    const credential = mode === 'signUp'
      ? await auth.createUserWithEmailAndPassword(email, password)
      : await auth.signInWithEmailAndPassword(email, password);
    elements.accountPasswordInput.value = '';
    elements.accountDialog.close();
    await migrateLocalBooksToAccount(credential.user);
  } catch (error) {
    showAccountError(authErrorMessage(error));
  }
}

// Books added before signing in live only in this browser's local storage.
// Once an account is available, copy them into it (skipping ISBNs already
// present there) so nothing already added seems to disappear, then clear the
// local copy so they don't get re-imported/duplicated on a later sign-in.
async function migrateLocalBooksToAccount(user) {
  const localBooks = storage.books;
  if (!localBooks.length) return;
  const confirmed = confirm(`You have ${localBooks.length} book(s) saved on this device. Add them to your account too?`);
  if (!confirmed) return;
  try {
    const existingSnapshot = await db.collection('users').doc(user.uid).collection('books').get();
    const existingIsbns = new Set(existingSnapshot.docs.map(doc => doc.data().isbn));
    const booksCollection = db.collection('users').doc(user.uid).collection('books');
    await Promise.all(localBooks
      .filter(book => !existingIsbns.has(book.isbn))
      .map(book => booksCollection.add(book)));
    storage.books = [];
    showToast('Your local books were added to your account.');
  } catch (error) {
    showToast('Could not move your local books to your account. They are still saved on this device.');
  }
}

if (firebaseReady) {
  auth.onAuthStateChanged(user => {
    currentUser = user;
    updateAccountUI();
    updateConnectionState();
    attachLibrarySource();
  });

  // Completes a Google sign-in that went the redirect route. Without this the
  // person returns signed in but is never offered the migration of the books
  // they added as a guest, which would look as though those books vanished.
  auth.getRedirectResult()
    .then(result => { if (result?.user) return migrateLocalBooksToAccount(result.user); })
    .catch(error => showAccountError(authErrorMessage(error)));
}

async function lookupBook() {
  const candidates = isbnCandidates(elements.isbnInput.value);
  const isbn = candidates[0];
  if (!isbn) { showToast('Enter a valid 10- or 13-digit ISBN from the barcode.'); elements.isbnInput.focus(); return; }
  elements.isbnInput.value = isbn;
  setLookupLoading(true);
  elements.resultSection.classList.add('hidden');

  try {
    for (const candidate of candidates) {
      // The bulk local archive (thousands of Bulgarian editions) is checked
      // first — instant, no network. Local catalogue and the small regional
      // cache come next; Open Library and Google Books are the network fallback.
      let book = bookArchive[candidate] || storage.catalogue[candidate] || regionalEditionCache[candidate];
      // Helikon comes before the international sources: it is a Bulgarian
      // catalogue, so for recent local editions it answers where Open Library
      // and Google Books usually don't. Its results are cached below, so any
      // one barcode reaches their servers at most once.
      if (!book) book = await fetchHelikonBook(candidate);
      if (!book) book = await fetchOpenLibraryBook(candidate);
      if (!book) book = await fetchGoogleBook(candidate);
      if (book) {
        activeBook = { ...book, isbn: candidate };
        renderResult(activeBook);
        return;
      }
    }
    renderSearchByTitle(isbn);
  } catch (error) {
    renderSearchByTitle(isbn);
    showToast('This edition was not in a public catalogue automatically. Search by title or add it once.');
  } finally { setLookupLoading(false); }
}

// Goes through our own Netlify function rather than helikon.bg directly:
// the browser would block a cross-origin request, and routing it server-side
// also lets one shared cache serve everyone instead of each visitor asking.
async function fetchHelikonBook(isbn) {
  // Own deadline, slightly above the function's: a stalled request must not
  // hold up Open Library and Google Books, which may well have the book.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`/.netlify/functions/lookup?isbn=${encodeURIComponent(isbn)}`,
      { signal: controller.signal });
    if (!response.ok) return null;          // 404 simply means "not stocked"
    const data = await response.json();
    if (!data || !data.found) return null;

    const book = {
      title: data.title || 'Untitled',
      authors: data.authors || 'Unknown author',
      published: data.published || '',
      publisher: data.publisher || '',
      description: data.description || '',
      pages: data.pages || '',
      cover: data.cover || '',
    };
    // Cached locally so a repeat scan of the same book never leaves the device.
    storage.catalogue = { ...storage.catalogue, [isbn]: book };
    return book;
  } catch {
    // Offline, timed out, or the function is unavailable — fall through.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchGoogleBook(isbn) {
  try {
    const response = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn)}`);
    // Public Google Books lookups can be temporarily rate-limited. In that
    // case (or if its response is unavailable), use Open Library instead.
    if (!response.ok) return null;
    const data = await response.json();
    const info = data.items?.[0]?.volumeInfo;
    if (!info) return null;
    return {
      title: info.title || 'Untitled',
      authors: info.authors?.join(', ') || 'Unknown author',
      published: info.publishedDate || '',
      publisher: info.publisher || '',
      description: info.description || 'No description available for this edition.',
      cover: info.imageLinks?.thumbnail?.replace('http:', 'https:') || '',
      source: 'Google Books',
    };
  } catch {
    return null;
  }
}

async function fetchOpenLibraryBook(isbn) {
  const response = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(isbn)}&format=json&jscmd=data`);
  if (!response.ok) throw new Error('lookup-failed');
  const info = (await response.json())[`ISBN:${isbn}`];
  if (!info) return null;
  return {
    title: info.title || 'Untitled',
    authors: info.authors?.map(author => author.name).join(', ') || 'Unknown author',
    published: info.publish_date || '',
    publisher: info.publishers?.map(publisher => publisher.name).join(', ') || '',
    description: info.notes || 'No description available for this edition.',
    cover: info.cover?.medium || '',
    source: 'Open Library',
  };
}

function renderResult(book) {
  const fragment = elements.resultTemplate.content.cloneNode(true);
  const cover = fragment.querySelector('.result-cover');
  cover.src = bookCover(book);
  cover.alt = `Cover of ${book.title}`;
  if (!book.cover) cover.classList.add('no-cover');
  fragment.querySelector('.result-title').textContent = book.title;
  fragment.querySelector('.result-author').textContent = book.authors;
  fragment.querySelector('.result-meta').textContent = [book.published, book.publisher].filter(Boolean).join(' · ') || `ISBN ${book.isbn}`;
  // Archive entries carry no description, so this must tolerate the field
  // being absent rather than assuming a string.
  const description = (book.description || '').replace(/<[^>]*>/g, '');
  const descriptionEl = fragment.querySelector('.result-description');
  descriptionEl.textContent = description;
  descriptionEl.hidden = !description;

  // Chosen before saving, so a book is shelved the moment it enters the
  // collection rather than needing a second pass later. A freshly looked-up
  // book has no place of its own, so it lands wherever the scan card points.
  activeLocationPicker = buildLocationPicker(storage.defaultLocation);
  const details = fragment.querySelector('.result-details');
  details.insertBefore(activeLocationPicker.element, fragment.querySelector('.result-actions'));

  // Scanning something already owned is ambiguous from the person's side, so
  // say plainly that this will become an extra copy rather than a duplicate.
  const owned = currentLibraryBooks.find(entry => entry.isbn === book.isbn);
  if (owned) {
    const note = document.createElement('p');
    note.className = 'already-owned';
    const n = copyCount(owned);
    note.textContent = `Already on your shelf (${n} ${n === 1 ? 'copy' : 'copies'}). Saving adds another.`;
    details.insertBefore(note, activeLocationPicker.element);
    fragment.querySelector('.save-book').textContent = 'Add another copy';
  }
  fragment.querySelector('.save-book').addEventListener('click', saveActiveBook);
  fragment.querySelector('.find-another').addEventListener('click', () => { elements.resultSection.classList.add('hidden'); elements.isbnInput.select(); });
  const cobissLink = document.createElement('a');
  cobissLink.className = 'button button-cobiss';
  cobissLink.href = cobissSearchUrl(book.isbn);
  cobissLink.target = '_blank';
  cobissLink.rel = 'noreferrer';
  cobissLink.textContent = 'Провери в COBISS.BG ↗';
  const goodreadsLink = document.createElement('a');
  goodreadsLink.className = 'button button-goodreads';
  goodreadsLink.href = goodreadsSearchUrl(book);
  goodreadsLink.target = '_blank';
  goodreadsLink.rel = 'noreferrer';
  goodreadsLink.textContent = 'Открий в Goodreads ↗';
  fragment.querySelector('.result-actions').append(cobissLink, goodreadsLink);
  elements.resultSection.replaceChildren(fragment);
  elements.resultSection.classList.remove('hidden');
  elements.resultSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderSearchByTitle(isbn) {
  elements.resultSection.innerHTML = `
    <article class="manual-entry">
      <div class="manual-entry-icon" aria-hidden="true">?</div>
      <div>
        <p class="match-label">Not matched by barcode yet</p>
        <h2>Search by title instead</h2>
        <p class="manual-copy">The barcode <code>${escapeHtml(isbn)}</code> is valid, but this exact edition isn't listed by Google Books or Open Library. Try the title (and author, if you know it) — this searches more broadly and usually finds regional editions.</p>
        <div class="manual-fields">
          <label>Book title<input id="search-title" autocomplete="off" placeholder="e.g. Title of the book" /></label>
          <label>Author (optional)<input id="search-authors" autocomplete="off" placeholder="e.g. Firstname Lastname" /></label>
        </div>
        <div class="result-actions">
          <button id="run-title-search" class="button button-primary">Search <span aria-hidden="true">→</span></button>
          <a class="button button-cobiss" href="${cobissSearchUrl(isbn)}" target="_blank" rel="noreferrer">Потърси в COBISS.BG ↗</a>
          <button id="cancel-search" class="button button-quiet">Cancel</button>
        </div>
        <div id="title-search-results" class="title-search-results"></div>
        <p class="manual-copy"><button id="show-manual-fields" class="text-button-inline">Can't find it? Add the details manually instead →</button></p>
      </div>
    </article>`;
  elements.resultSection.classList.remove('hidden');

  const runSearch = async () => {
    const title = document.querySelector('#search-title').value.trim();
    const authors = document.querySelector('#search-authors').value.trim();
    if (!title) { showToast('Enter at least a title to search.'); return; }
    const resultsBox = document.querySelector('#title-search-results');
    resultsBox.innerHTML = '<p class="manual-copy">Searching…</p>';
    const matches = await fetchTitleMatches(title, authors);
    if (!matches.length) {
      resultsBox.innerHTML = '<p class="manual-copy">No matches found. Try a shorter title, or add the book manually below.</p>';
      return;
    }
    resultsBox.innerHTML = matches.map((match, index) => `
      <button class="title-match" data-index="${index}">
        <img src="${bookCover(match)}" alt="" />
        <span>
          <strong>${escapeHtml(match.title)}</strong>
          <em>${escapeHtml(match.authors)}</em>
          <small>${escapeHtml([match.published, match.source].filter(Boolean).join(' · '))}</small>
        </span>
      </button>`).join('');
    resultsBox.querySelectorAll('.title-match').forEach(button => {
      button.addEventListener('click', () => {
        const match = matches[Number(button.dataset.index)];
        activeBook = { ...match, isbn };
        renderResult(activeBook);
      });
    });
  };

  document.querySelector('#run-title-search').addEventListener('click', runSearch);
  document.querySelector('#search-title').addEventListener('keydown', event => { if (event.key === 'Enter') runSearch(); });
  document.querySelector('#cancel-search').addEventListener('click', () => elements.resultSection.classList.add('hidden'));
  document.querySelector('#show-manual-fields').addEventListener('click', () => renderManualEntry(isbn));
  elements.resultSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function fetchTitleMatches(title, authors) {
  const [openLibraryMatches, googleMatches] = await Promise.all([
    fetchOpenLibraryByTitle(title, authors),
    fetchGoogleByTitle(title, authors),
  ]);
  // De-duplicate near-identical entries (same title + author) across sources.
  const seen = new Set();
  return [...openLibraryMatches, ...googleMatches].filter(match => {
    const key = `${match.title.toLowerCase()}|${match.authors.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
}

async function fetchOpenLibraryByTitle(title, authors) {
  try {
    const params = new URLSearchParams({ title, limit: '5' });
    if (authors) params.set('author', authors);
    const response = await fetch(`https://openlibrary.org/search.json?${params}`);
    if (!response.ok) return [];
    const data = await response.json();
    return (data.docs || []).map(doc => ({
      title: doc.title || 'Untitled',
      authors: (doc.author_name || []).join(', ') || 'Unknown author',
      published: doc.first_publish_year ? String(doc.first_publish_year) : '',
      publisher: (doc.publisher || [])[0] || '',
      description: 'No description available for this edition.',
      cover: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg` : '',
      source: 'Open Library',
    }));
  } catch { return []; }
}

async function fetchGoogleByTitle(title, authors) {
  try {
    const query = `intitle:${title}${authors ? `+inauthor:${authors}` : ''}`;
    const response = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=5`);
    if (!response.ok) return [];
    const data = await response.json();
    return (data.items || []).map(item => {
      const info = item.volumeInfo || {};
      return {
        title: info.title || 'Untitled',
        authors: info.authors?.join(', ') || 'Unknown author',
        published: info.publishedDate || '',
        publisher: info.publisher || '',
        description: info.description || 'No description available for this edition.',
        cover: info.imageLinks?.thumbnail?.replace('http:', 'https:') || '',
        source: 'Google Books',
      };
    });
  } catch { return []; }
}

function renderManualEntry(isbn) {
  elements.resultSection.innerHTML = `
    <article class="manual-entry">
      <div class="manual-entry-icon" aria-hidden="true">+</div>
      <div>
        <p class="match-label">Edition not in public catalogue</p>
        <h2>Add this book once</h2>
        <p class="manual-copy">The barcode <code>${escapeHtml(isbn)}</code> is valid, but this edition isn't listed anywhere searchable. Add the title and author below; it will be recognised instantly on every future scan.</p>
        <div class="manual-fields">
          <label>Book title<input id="manual-title" autocomplete="off" placeholder="e.g. Title of the book" /></label>
          <label>Author(s)<input id="manual-authors" autocomplete="off" placeholder="e.g. Firstname Lastname" /></label>
        </div>
        <div class="result-actions"><button id="save-manual-book" class="button button-primary">Save this book <span aria-hidden="true">→</span></button><a class="button button-cobiss" href="${cobissSearchUrl(isbn)}" target="_blank" rel="noreferrer">Потърси в COBISS.BG ↗</a><button id="cancel-manual" class="button button-quiet">Cancel</button></div>
      </div>
    </article>`;
  elements.resultSection.classList.remove('hidden');
  document.querySelector('#save-manual-book').addEventListener('click', () => {
    const title = document.querySelector('#manual-title').value.trim();
    const authors = document.querySelector('#manual-authors').value.trim();
    if (!title || !authors) { showToast('Add both the title and author before saving.'); return; }
    activeBook = { isbn, title, authors, published: '', publisher: '', description: 'Added manually because this edition was not available in the public catalogues.', cover: '', source: 'Manual entry' };
    renderResult(activeBook);
  });
  document.querySelector('#cancel-manual').addEventListener('click', () => elements.resultSection.classList.add('hidden'));
  elements.resultSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function saveActiveBook() {
  if (!activeBook) return;
  const location = activeLocationPicker ? activeLocationPicker.value() : '';
  const existing = currentLibraryBooks.find(book => book.isbn === activeBook.isbn);

  // Scanning a book already on the shelf means a second physical copy, not a
  // mistake — a duplicate edition is a normal thing to own.
  if (existing) {
    document.querySelector('.save-book')?.setAttribute('disabled', '');
    const copies = [...bookCopies(existing), { location, addedAt: new Date().toISOString() }];
    await persistCopies(existing, copies);
    showToast(`Added a second home for this title — you now have ${copies.length} copies.`);
    return;
  }

  const book = {
    ...activeBook,
    copies: [{ location, addedAt: new Date().toISOString() }],
    addedAt: new Date().toISOString(),
  };
  // Remember this edition locally so the same barcode is matched instantly next time,
  // regardless of whether it came from a direct match, a title search, or manual entry,
  // and regardless of whether the person is signed in.
  // The catalogue is a bibliographic cache shared by every future scan, so
  // the personal shelf placement is deliberately left out of it.
  const { copies: _copies, location: _shelf, addedAt: _added, ...bibliographic } = book;
  storage.catalogue = { ...storage.catalogue, [book.isbn]: bibliographic };
  document.querySelector('.save-book')?.setAttribute('disabled', '');

  if (currentUser && firebaseReady) {
    try {
      await db.collection('users').doc(currentUser.uid).collection('books').add(book);
      // The onSnapshot listener attached in attachLibrarySource() re-renders automatically.
    } catch (error) {
      showToast('Could not save to your account. Please try again.');
      return;
    }
  } else {
    storage.books = [book, ...storage.books];
    currentLibraryBooks = storage.books;
    renderLibrary();
  }

  showToast(currentUser ? 'Saved to your account — it will follow you on any device.' : 'Saved to your local collection. Sign in to keep it on every device.');
}

// Writes a whole copies array back to whichever store is currently backing
// the collection. Removing the last copy removes the book itself, since a
// title with no physical copies isn't on the shelf any more.
async function persistCopies(book, copies) {
  if (currentUser && firebaseReady && book.id) {
    const ref = db.collection('users').doc(currentUser.uid).collection('books').doc(book.id);
    try {
      if (copies.length === 0) await ref.delete();
      // `location` is cleared so an older client can't resurrect a stale place.
      else await ref.update({ copies, location: firebase.firestore.FieldValue.delete() });
      // onSnapshot re-renders for us.
    } catch (error) {
      showToast('Could not update that book. Please try again.');
    }
    return;
  }
  storage.books = copies.length === 0
    ? storage.books.filter(entry => entry.isbn !== book.isbn)
    : storage.books.map(entry => {
        if (entry.isbn !== book.isbn) return entry;
        const { location: _drop, ...rest } = entry;
        return { ...rest, copies };
      });
  currentLibraryBooks = storage.books;
  renderLibrary();
}

function updateCopyLocation(book, index, location) {
  const copies = bookCopies(book).map((copy, i) =>
    i === index ? { ...copy, location } : copy);
  return persistCopies(book, copies);
}

function removeCopy(book, index) {
  const copies = bookCopies(book).filter((_, i) => i !== index);
  return persistCopies(book, copies);
}

// Removes the title and every copy of it. Destructive and not undoable, so it
// always asks first, and says how many copies are about to go.
async function deleteBook(book) {
  const copies = copyCount(book);
  const what = copies > 1 ? `“${book.title}” and all ${copies} copies` : `“${book.title}”`;
  if (!confirm(`Remove ${what} from your collection?`)) return;
  await persistCopies(book, []);
  showToast('Removed from your collection.');
}

// Renders the copies of one book as a horizontally swipeable strip: one panel
// per physical copy, each with its own place. Scroll snapping makes each panel
// settle into view rather than stopping halfway between two.
function buildCopiesStrip(book) {
  const copies = bookCopies(book);
  const wrapper = document.createElement('div');
  wrapper.className = 'copies';

  const track = document.createElement('div');
  track.className = 'copies-track';

  copies.forEach((copy, index) => {
    const panel = document.createElement('div');
    panel.className = 'copy-panel';

    const head = document.createElement('div');
    head.className = 'copy-head';
    const badge = document.createElement('span');
    badge.className = 'copy-badge';
    badge.textContent = copies.length > 1
      ? `Copy ${index + 1} of ${copies.length}`
      : 'One copy';
    head.append(badge);

    // Only meaningful with more than one copy; removing the title as a whole
    // is the × on the card, so the two actions can't be confused.
    if (copies.length > 1) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'copy-remove';
      remove.textContent = 'Remove this copy';
      remove.setAttribute('aria-label', `Remove copy ${index + 1} of ${book.title}`);
      remove.addEventListener('click', () => removeCopy(book, index));
      head.append(remove);
    }

    const picker = buildLocationPicker(copy.location || '', { label: 'Kept in' });
    picker.element.classList.add('library-location');
    picker.element.querySelector('.location-select').addEventListener('change', event => {
      if (event.target.value !== NEW_LOCATION_VALUE) updateCopyLocation(book, index, event.target.value);
    });
    const input = picker.element.querySelector('.location-new-input');
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') updateCopyLocation(book, index, picker.value());
    });
    input.addEventListener('blur', () => {
      const value = picker.value();
      if (value) updateCopyLocation(book, index, value);
    });

    panel.append(head, picker.element);
    track.append(panel);
  });

  wrapper.append(track);

  // Dots are only meaningful once there is somewhere to swipe to.
  if (copies.length > 1) {
    const dots = document.createElement('div');
    dots.className = 'copy-dots';
    copies.forEach((_, index) => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'copy-dot' + (index === 0 ? ' active' : '');
      dot.setAttribute('aria-label', `Show copy ${index + 1}`);
      dot.addEventListener('click', () => {
        track.scrollTo({ left: track.clientWidth * index, behavior: 'smooth' });
      });
      dots.append(dot);
    });
    track.addEventListener('scroll', () => {
      const current = Math.round(track.scrollLeft / track.clientWidth);
      dots.querySelectorAll('.copy-dot').forEach((dot, index) =>
        dot.classList.toggle('active', index === current));
    }, { passive: true });
    wrapper.append(dots);
  }

  return wrapper;
}

function renderLocationFilter() {
  const places = knownLocations();
  const host = elements.locationFilter;
  if (!host) return;
  host.hidden = places.length === 0;
  const current = storage.locationFilter;
  host.replaceChildren();
  host.append(new Option('All places', ''));
  places.forEach(place => host.append(new Option(place, place)));
  host.append(new Option('Not placed yet', '__none__'));
  host.value = [...places, '', '__none__'].includes(current) ? current : '';
}

function visibleBooks() {
  const filter = storage.locationFilter;
  if (!filter) return currentLibraryBooks;
  // A title stays visible when any one of its copies is in the chosen place.
  if (filter === '__none__') {
    return currentLibraryBooks.filter(book => bookCopies(book).some(copy => !copy.location));
  }
  return currentLibraryBooks.filter(book =>
    bookCopies(book).some(copy => copy.location === filter));
}

// One entry per physical copy, for the views where a copy is the unit: the
// spreadsheet and the exports, where counting books on a shelf is the point.
function visibleCopyRows() {
  const filter = storage.locationFilter;
  return currentLibraryBooks.flatMap(book => {
    const copies = bookCopies(book);
    return copies
      .map((copy, index) => ({ book, copy, index, total: copies.length }))
      .filter(({ copy }) => {
        if (!filter) return true;
        if (filter === '__none__') return !copy.location;
        return copy.location === filter;
      });
  });
}

function renderLibrary() {
  renderLocationFilter();
  // Places can be invented from the result card or from a saved book, so the
  // scan-card picker is repainted here to stay in step with both.
  renderDefaultPlacePicker();
  const books = visibleBooks();
  const total = currentLibraryBooks.length;
  elements.emptyLibrary.hidden = total > 0;
  elements.clearLibrary.hidden = total === 0;
  elements.exportXlsxButton.hidden = total === 0;
  elements.exportCsvButton.hidden = total === 0;

  const view = storage.libraryView;
  elements.viewCardsButton.classList.toggle('active', view === 'cards');
  elements.viewSheetButton.classList.toggle('active', view === 'sheet');

  if (view === 'sheet') {
    elements.libraryList.classList.add('hidden');
    if (!elements.sheetWrapper) {
      elements.sheetWrapper = document.createElement('div');
      elements.sheetWrapper.className = 'sheet-wrapper';
      elements.libraryList.after(elements.sheetWrapper);
    }
    elements.sheetWrapper.classList.remove('hidden');
    const rows = visibleCopyRows();
    elements.sheetWrapper.innerHTML = rows.length === 0 ? '' : `
      <table class="sheet-table">
        <thead><tr><th>Added</th><th>Title</th><th>Author(s)</th><th>ISBN</th><th>Published</th><th>Publisher</th><th>Copy</th><th>Place</th></tr></thead>
        <tbody>${rows.map(({ book, copy, index, total }) => `
          <tr>
            <td>${new Date(copy.addedAt || book.addedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</td>
            <td class="sheet-title">${escapeHtml(book.title)}</td>
            <td>${escapeHtml(book.authors)}</td>
            <td class="sheet-isbn">${escapeHtml(book.isbn || '')}</td>
            <td>${escapeHtml(book.published || '')}</td>
            <td>${escapeHtml(book.publisher || '')}</td>
            <td class="sheet-copy">${total > 1 ? `${index + 1} / ${total}` : '1'}</td>
            <td class="sheet-place">${escapeHtml(copy.location || '—')}</td>
          </tr>`).join('')}</tbody>
      </table>`;
    return;
  }

  elements.libraryList.classList.remove('hidden');
  elements.sheetWrapper?.classList.add('hidden');

  // A filter that matches nothing would otherwise leave a silent blank gap,
  // since the general empty state is reserved for a genuinely empty shelf.
  if (books.length === 0 && total > 0) {
    const notice = document.createElement('p');
    notice.className = 'library-filter-empty';
    notice.textContent = storage.locationFilter === '__none__'
      ? 'Every book has a place assigned.'
      : 'No books kept here yet.';
    elements.libraryList.replaceChildren(notice);
    return;
  }

  elements.libraryList.replaceChildren(...books.map(book => {
    const copies = copyCount(book);
    const item = document.createElement('article');
    item.className = 'library-item';
    item.innerHTML = `
      <img class="library-cover" src="${bookCover(book)}" alt="" />
      <div class="library-body">
        <h3 class="library-title">${escapeHtml(book.title)}${copies > 1 ? `<span class="copy-count">×${copies}</span>` : ''}</h3>
        <p class="library-author">${escapeHtml(book.authors)}</p>
      </div>
      <div class="library-aside">
        <time class="library-date" datetime="${book.addedAt}">${new Date(book.addedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</time>
      </div>`;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'library-delete';
    remove.innerHTML = '<span aria-hidden="true">×</span>';
    remove.title = 'Remove from collection';
    remove.setAttribute('aria-label', `Remove ${book.title} from your collection`);
    remove.addEventListener('click', () => deleteBook(book));
    item.querySelector('.library-aside').append(remove);

    // Copies move around independently in real life, so each keeps its own
    // editable place rather than the title having a single fixed one.
    item.querySelector('.library-body').append(buildCopiesStrip(book));
    return item;
  }));
}

const EXPORT_COLUMNS = ['Added at', 'Title', 'Author(s)', 'ISBN', 'Published', 'Publisher', 'Copy', 'Place'];

// A row per physical copy, so the sheet totals match what is actually on the
// shelves rather than counting distinct titles.
function copyRowToExportRow({ book, copy, index, total }) {
  return [
    new Date(copy.addedAt || book.addedAt).toISOString(),
    book.title || '',
    book.authors || '',
    book.isbn || '',
    book.published || '',
    book.publisher || '',
    total > 1 ? `${index + 1} of ${total}` : '1',
    copy.location || '',
  ];
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

// Exports follow what's on screen: with a place filter active, you get that
// shelf rather than the whole collection, which is what makes "print a list
// for one bookcase" possible.
function exportFilename(extension) {
  const filter = storage.locationFilter;
  if (!filter || filter === '__none__') return `my-collection.${extension}`;
  const slug = filter.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
  return `my-collection-${slug || 'place'}.${extension}`;
}

function exportXlsx() {
  if (!window.XLSX) { showToast('Export library did not load. Check your connection and try again.'); return; }
  const rows = [EXPORT_COLUMNS, ...visibleCopyRows().map(copyRowToExportRow)];
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet['!cols'] = [{ wch: 20 }, { wch: 32 }, { wch: 24 }, { wch: 15 }, { wch: 12 }, { wch: 20 }, { wch: 9 }, { wch: 22 }];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Books');
  XLSX.writeFile(workbook, exportFilename('xlsx'));
}

function exportCsv() {
  const escapeCsvCell = value => `"${String(value).replace(/"/g, '""')}"`;
  const rows = [EXPORT_COLUMNS, ...visibleCopyRows().map(copyRowToExportRow)];
  const csv = rows.map(row => row.map(escapeCsvCell).join(',')).join('\r\n');
  downloadBlob(new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8;' }), exportFilename('csv'));
}

function stopCamera() {
  clearInterval(scanTimer);
  scanTimer = null;
  cameraStream?.getTracks().forEach(track => track.stop());
  cameraStream = null;
  elements.cameraVideo.srcObject = null;
  zxingControls?.stop();
  zxingControls = null;
}

async function startCamera() {
  // Chrome/Edge/Android support the native BarcodeDetector API directly.
  // Safari (iOS and macOS) doesn't implement it, so ZXing (loaded from CDN)
  // decodes barcodes from the video stream in plain JS instead.
  if ('BarcodeDetector' in window) return startNativeCamera();
  if (window.ZXing) return startZXingCamera();
  showToast('Camera barcode scanning is not supported in this browser. Enter the ISBN instead.');
}

async function startNativeCamera() {
  elements.cameraDialog.showModal();
  elements.cameraStatus.textContent = 'Starting camera…';
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    elements.cameraVideo.srcObject = cameraStream;
    await elements.cameraVideo.play();
    const detector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'] });
    elements.cameraStatus.textContent = 'Looking for a barcode…';
    scanTimer = setInterval(async () => {
      if (!elements.cameraVideo.videoWidth) return;
      const codes = await detector.detect(elements.cameraVideo).catch(() => []);
      const barcode = codes[0]?.rawValue;
      if (barcode) {
        elements.isbnInput.value = barcode;
        stopCamera();
        elements.cameraDialog.close();
        showToast(`Barcode ${barcode} scanned. Looking it up…`);
        lookupBook();
      }
    }, 400);
  } catch (error) {
    elements.cameraStatus.textContent = 'Camera permission was not granted.';
    showToast('Camera access was not available. You can enter the ISBN manually.');
  }
}

async function startZXingCamera() {
  elements.cameraDialog.showModal();
  elements.cameraStatus.textContent = 'Starting camera…';
  try {
    const hints = new Map();
    hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [
      ZXing.BarcodeFormat.EAN_13, ZXing.BarcodeFormat.EAN_8,
      ZXing.BarcodeFormat.UPC_A, ZXing.BarcodeFormat.UPC_E, ZXing.BarcodeFormat.CODE_128,
    ]);
    const reader = new ZXing.BrowserMultiFormatReader(hints);
    elements.cameraStatus.textContent = 'Looking for a barcode…';
    zxingControls = await reader.decodeFromConstraints(
      { video: { facingMode: { ideal: 'environment' } }, audio: false },
      elements.cameraVideo,
      (result) => {
        // The callback fires continuously (with a NotFoundException) while no
        // barcode is in frame; only act once a result is actually decoded.
        if (!result) return;
        const barcode = result.getText();
        elements.isbnInput.value = barcode;
        stopCamera();
        elements.cameraDialog.close();
        showToast(`Barcode ${barcode} scanned. Looking it up…`);
        lookupBook();
      },
    );
  } catch (error) {
    elements.cameraStatus.textContent = 'Camera permission was not granted.';
    showToast('Camera access was not available. You can enter the ISBN manually.');
  }
}

document.querySelectorAll('.sample-isbn').forEach(button => button.addEventListener('click', () => { elements.isbnInput.value = button.dataset.isbn; lookupBook(); }));
elements.lookupButton.addEventListener('click', lookupBook);
elements.isbnInput.addEventListener('keydown', event => { if (event.key === 'Enter') lookupBook(); });
elements.cameraButton.addEventListener('click', startCamera);
document.querySelector('#close-camera').addEventListener('click', () => elements.cameraDialog.close());
elements.cameraDialog.addEventListener('close', stopCamera);
elements.clearLibrary.addEventListener('click', async () => {
  if (!confirm('Clear all books in your collection?')) return;
  if (currentUser && firebaseReady) {
    const snapshot = await db.collection('users').doc(currentUser.uid).collection('books').get();
    const batch = db.batch();
    snapshot.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    showToast('Your account collection was cleared.');
  } else {
    storage.books = [];
    currentLibraryBooks = [];
    renderLibrary();
    showToast('Local collection cleared.');
  }
});
elements.locationFilter?.addEventListener('change', event => {
  storage.locationFilter = event.target.value;
  renderLibrary();
});
elements.viewCardsButton.addEventListener('click', () => { storage.libraryView = 'cards'; renderLibrary(); });
elements.viewSheetButton.addEventListener('click', () => { storage.libraryView = 'sheet'; renderLibrary(); });
elements.exportXlsxButton.addEventListener('click', exportXlsx);
elements.exportCsvButton.addEventListener('click', exportCsv);
elements.openAccountButton.addEventListener('click', () => { elements.accountError.classList.add('hidden'); elements.accountDialog.showModal(); });
document.querySelector('#close-account').addEventListener('click', () => elements.accountDialog.close());
document.querySelector('#google-sign-in').addEventListener('click', handleGoogleSignIn);
document.querySelector('#sign-in-button').addEventListener('click', () => handleAuthAction('signIn'));
document.querySelector('#sign-up-button').addEventListener('click', () => handleAuthAction('signUp'));
document.querySelector('#sign-out-button').addEventListener('click', () => auth?.signOut());
document.querySelector('#forgot-password').addEventListener('click', async () => {
  elements.accountError.classList.add('hidden');
  if (!firebaseReady) { showAccountError('Accounts are not set up on this site yet.'); return; }
  const email = elements.accountEmailInput.value.trim();
  if (!email) { showAccountError('Enter your email above, then tap this again.'); return; }
  try {
    await auth.sendPasswordResetEmail(email);
    showToast(`Password reset email sent to ${email}.`);
  } catch (error) {
    showAccountError(authErrorMessage(error));
  }
});

updateConnectionState();
updateAccountUI();
if (!firebaseReady) attachLibrarySource();
loadBookArchive();
