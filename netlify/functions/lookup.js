/**
 * Търси книга в Helikon.bg по баркод и връща метаданните ѝ като JSON.
 *
 * Работи като прокси: браузърът не може да пита helikon.bg директно (CORS),
 * но тази функция върви на сървъра на Netlify, където CORS не важи.
 *
 * Защо Хеликон, а не Озон: страниците на Хеликон се рендират сървърно и
 * носят ISBN в мета таг <meta property="books:isbn">. При Озон резултатите
 * от търсенето се рисуват с JavaScript от външна платена услуга, тоест не
 * се виждат при обикновено теглене.
 */

const SEARCH_URL = q => `https://www.helikon.bg/search/?q=${encodeURIComponent(q)}`;

// Честно се представяме, вместо да се маскираме като браузър.
// Задължително само ASCII: HTTP заглавките не приемат кирилица.
const USER_AGENT =
  'FindAndAddYourBook/1.0 (personal book catalogue; +https://dulcet-kelpie-972af5.netlify.app)';

// Netlify прекратява функциите след 10 секунди. Всяка заявка има свой лимит,
// а DEADLINE_MS пази общия сбор под тавана: без него пет бавни страници по
// осем секунди щяха да надхвърлят лимита и да върнат грешка вместо книга.
const TIMEOUT_MS = 3500;
const MAX_CANDIDATES = 3;
const DEADLINE_MS = 8500;

// --- ISBN проверка -------------------------------------------------------

function normalise(value) {
  return String(value || '').replace(/[^0-9Xx]/g, '').toUpperCase();
}

function validEan13(v) {
  if (!/^\d{13}$/.test(v)) return false;
  const sum = [...v].slice(0, 12)
    .reduce((acc, d, i) => acc + Number(d) * (i % 2 ? 3 : 1), 0);
  return (10 - sum % 10) % 10 === Number(v[12]);
}

// --- Теглене -------------------------------------------------------------

async function get(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'bg-BG,bg;q=0.9,en;q=0.8',
      },
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, status: response.status, text: '' };
    return { ok: true, status: response.status, text: await response.text() };
  } catch (error) {
    return {
      ok: false,
      status: `${error.name}: ${error.message}${error.cause ? ' | ' + error.cause.message : ''}`,
      text: '',
    };
  } finally {
    clearTimeout(timer);
  }
}

// --- Парсване ------------------------------------------------------------

const strip = html => html
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&quot;/g, '"')
  .replace(/&#039;|&apos;/g, "'")
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&hellip;/g, '…')
  .replace(/&laquo;|&bdquo;/g, '„')
  .replace(/&raquo;|&ldquo;/g, '“')
  .replace(/\s+/g, ' ')
  .trim();

/** Чете <meta property="..." content="..."> в който и да е ред на атрибутите. */
function metaContent(html, property) {
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]*content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${property}["']`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return strip(match[1]);
  }
  return '';
}

/** Чете стойност от таблицата с характеристики по надписа в лявата клетка. */
function tableValue(html, label) {
  const patterns = [
    new RegExp(`>\\s*${label}\\s*<\\/t[dh]>\\s*<t[dh][^>]*>([\\s\\S]*?)<\\/t[dh]>`, 'i'),
    new RegExp(`${label}\\s*<\\/[^>]+>\\s*<[^>]+>([\\s\\S]{0,300}?)<\\/`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      const value = strip(match[1]);
      if (value) return value;
    }
  }
  return '';
}

/** Авторът стои като връзка към страницата му. */
function authorFrom(html) {
  const matches = [...html.matchAll(
    /<a[^>]+href=["'](?:https:\/\/www\.helikon\.bg)?\/author\/[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)];
  const names = [...new Set(matches.map(m => strip(m[1])).filter(Boolean))];
  return names.join(', ');
}

function parseProduct(html) {
  return {
    title: metaContent(html, 'og:title').replace(/\s*\|\s*Цена.*$/i, '').trim(),
    authors: authorFrom(html),
    publisher: tableValue(html, 'Издател'),
    published: tableValue(html, 'Година на издаване'),
    pages: tableValue(html, 'Брой страници'),
    binding: tableValue(html, 'Корици'),
    language: tableValue(html, 'Език'),
    cover: metaContent(html, 'og:image'),
    description: metaContent(html, 'og:description').replace(/\s*\|\s*Цена.*$/i, '').trim(),
    // Мета тагът е най-надеждният източник; таблицата служи за подсигуряване.
    isbn: normalise(metaContent(html, 'books:isbn')) || normalise(tableValue(html, 'ISBN')),
    barcode: normalise(tableValue(html, 'Баркод')),
  };
}

/**
 * Адресите на книгите са вида /253830-Заглавие.html — числото отпред ги
 * отличава от /author/, /publisher/ и /books/, чиито пътища започват с дума.
 *
 * Приемаме и абсолютни, и относителни адреси: сайтът може да изписва кой да
 * е от двата вида, а изискването само за абсолютни е причината търсенето да
 * не намираше нищо. Плъзгачите съдържат запетаи, двоеточия и наклонени черти.
 */
function productLinks(html, limit = MAX_CANDIDATES) {
  const paths = new Set();

  const withHref = /href=["'](?:https?:\/\/(?:www|m)\.helikon\.bg)?(\/\d+-[^"']*?\.html)["']/gi;
  let match;
  while ((match = withHref.exec(html)) && paths.size < limit) paths.add(match[1]);

  // Подсигуряване, ако атрибутът е изписан необичайно. Закотвено след кавичка
  // или интервал, иначе /author/11766-Ime.html би дало „/11766-Ime.html“ и
  // функцията щеше да отвори страница на автор вместо книга.
  if (paths.size === 0) {
    const bare = /(?<=["'\s])(?:https?:\/\/(?:www|m)\.helikon\.bg)?(\/\d+-[^\s"'<>]*?\.html)/gi;
    while ((match = bare.exec(html)) && paths.size < limit) paths.add(match[1]);
  }

  return [...paths].map(path => `https://www.helikon.bg${path}`);
}

// --- Основна логика ------------------------------------------------------

exports.handler = async function (event) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    // Кратък кеш: достатъчен да поеме повторни заявки, но не толкова дълъг,
    // че да пречи при отстраняване на грешки.
    'Cache-Control': 'public, max-age=3600',
  };

  const isbn = normalise((event.queryStringParameters || {}).isbn);

  // Проверката на контролната цифра става тук, за да не изпращаме към
  // Хеликон заявки за боклук — сгрешено въвеждане не бива да им товари сървъра.
  if (!validEan13(isbn)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'invalid-barcode' }) };
  }

  const startedAt = Date.now();
  const timeLeft = () => DEADLINE_MS - (Date.now() - startedAt);

  const searchUrl = SEARCH_URL(isbn);
  const search = await get(searchUrl);
  if (!search.ok) {
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ found: false, stage: 'search', status: search.status, url: searchUrl }),
    };
  }

  const links = productLinks(search.text);
  if (links.length === 0) {
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ found: false, stage: 'no-results', url: searchUrl }),
    };
  }

  // Всеки кандидат се приема само ако ISBN-ът на страницата съвпада точно
  // със сканирания. Търсачката може да върне сродни издания, а грешно
  // записана книга е по-лоша от ненамерена.
  const checked = [];
  for (const link of links) {
    // Спираме, преди Netlify да ни прекъсне: по-добре честен отговор
    // „не е намерено“, отколкото прекъсната функция без обяснение.
    if (timeLeft() < TIMEOUT_MS) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ found: false, stage: 'deadline', checked }),
      };
    }
    const page = await get(link);
    if (!page.ok) { checked.push({ link, status: page.status }); continue; }

    const product = parseProduct(page.text);
    checked.push({ link, isbn: product.isbn || null });
    if (product.isbn !== isbn && product.barcode !== isbn) continue;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        found: true,
        isbn,
        title: product.title,
        authors: product.authors,
        publisher: product.publisher,
        published: product.published,
        pages: product.pages,
        binding: product.binding,
        language: product.language,
        cover: product.cover,
        description: product.description,
        source: 'Helikon.bg',
        url: link,
      }),
    };
  }

  return {
    statusCode: 404,
    headers,
    body: JSON.stringify({ found: false, stage: 'no-isbn-match', checked }),
  };
};
