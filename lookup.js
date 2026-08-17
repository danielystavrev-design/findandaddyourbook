/**
 * Търси книга в Ozone.bg по баркод и връща метаданните ѝ като JSON.
 *
 * Работи като прокси: браузърът не може да пита ozone.bg директно (CORS),
 * но тази функция върви на сървъра на Netlify, където CORS не важи.
 *
 * ПРЕДИ УПОТРЕБА:
 *   1. Отвори https://www.ozone.bg/robots.txt и провери дали /product/ и
 *      търсенето са разрешени. Ако са забранени — не пускай това.
 *   2. Провери SEARCH_URL по-долу: направи търсене в сайта и виж какъв
 *      адрес се появява в лентата. Долното е предположение.
 */

// ⚠ ПРОВЕРИ ТОВА — направи търсене в ozone.bg и копирай реалния формат.
const SEARCH_URL = q => `https://www.ozone.bg/search/?q=${encodeURIComponent(q)}`;

// Честно се представяме, вместо да се маскираме като браузър. Ако някой от
// Озон погледне логовете си, трябва да вижда какво е това и кой стои зад него.
const USER_AGENT =
  'FindAndAddYourBook/1.0 (личен каталог на книги; +https://dulcet-kelpie-972af5.netlify.app)';

const TIMEOUT_MS = 8000;

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
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'bg' },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
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
  .replace(/\s+/g, ' ')
  .trim();

/**
 * Изважда стойност от таблицата „Всички характеристики“, където редовете са
 * <th>Име</th><td>Стойност</td> или подобна двойка клетки.
 */
function tableValue(html, label) {
  const pattern = new RegExp(
    `<t[hd][^>]*>\\s*${label}\\s*:?\\s*</t[hd]>\\s*<t[hd][^>]*>([\\s\\S]*?)</t[hd]>`,
    'i');
  const match = html.match(pattern);
  return match ? strip(match[1]) : '';
}

function metaContent(html, property) {
  const pattern = new RegExp(
    `<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']*)["']`, 'i');
  const match = html.match(pattern);
  return match ? strip(match[1]) : '';
}

function parseProduct(html) {
  const title = metaContent(html, 'og:title')
    || strip((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '');

  return {
    title,
    authors: tableValue(html, 'Автор'),
    publisher: tableValue(html, 'Издателство'),
    published: tableValue(html, 'Година'),
    pages: tableValue(html, 'Брой страници'),
    binding: tableValue(html, 'Издание'),
    language: tableValue(html, 'Език'),
    series: tableValue(html, 'Колекция'),
    cover: metaContent(html, 'og:image'),
    description: metaContent(html, 'og:description'),
    // И двете полета се срещат; „Баркод“ е по-надеждно налично от „ISBN“.
    barcode: normalise(tableValue(html, 'Баркод')),
    isbnField: normalise(tableValue(html, 'ISBN')),
  };
}

/** Извлича адресите на продуктови страници от резултатите на търсенето. */
function productLinks(html, limit = 5) {
  const found = new Set();
  const pattern = /href=["'](https:\/\/www\.ozone\.bg\/product\/[^"'?#]+)["']/gi;
  let match;
  while ((match = pattern.exec(html)) && found.size < limit) found.add(match[1]);
  return [...found];
}

// --- Основна логика ------------------------------------------------------

exports.handler = async function (event) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    // Кешираме на ръба на Netlify: същият баркод не тръгва пак към Озон
    // цяло денонощие, дори да го поискат сто души.
    'Cache-Control': 'public, max-age=86400',
  };

  const isbn = normalise((event.queryStringParameters || {}).isbn);

  // Проверката на контролната цифра става тук, за да не изпращаме към Озон
  // заявки за боклук — сгрешено въвеждане не бива да им товари сървъра.
  if (!validEan13(isbn)) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'invalid-barcode' }),
    };
  }

  const searchHtml = await get(SEARCH_URL(isbn));
  if (!searchHtml) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'search-failed' }) };
  }

  const links = productLinks(searchHtml);
  if (links.length === 0) {
    return { statusCode: 404, headers, body: JSON.stringify({ found: false }) };
  }

  // Търсачката на Озон е размита и никога не връща нула резултата — на
  // безсмислица отговаря с трийсет несвързани продукта. Затова всеки
  // кандидат се приема само ако баркодът на страницата съвпада точно със
  // сканирания. Без тази проверка ще се записват грешни книги.
  for (const link of links) {
    const productHtml = await get(link);
    if (!productHtml) continue;

    const product = parseProduct(productHtml);
    if (product.barcode !== isbn && product.isbnField !== isbn) continue;

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
        cover: product.cover,
        description: product.description,
        series: product.series,
        source: 'Ozone.bg',
        url: link,
      }),
    };
  }

  // Имало е резултати, но никой не е бил търсената книга.
  return { statusCode: 404, headers, body: JSON.stringify({ found: false }) };
};
