const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const http = require("http");
const puppeteer = require("puppeteer-core");

axios.defaults.maxRedirects = 5;
axios.defaults.followRedirect = true;

const CONFIG_FILE = "config.json";
const STATE_FILE = "stock_state.json";
const KEEPALIVE_PORT = 3000;
const CHROME_PATH = "/usr/bin/google-chrome";

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) { console.error("❌ config.json not found."); process.exit(1); }
  return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
}
function loadState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}
function saveState(state) { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }

// ─── BROWSER POOL ──────────────────────────────────────────────────────────

let browser = null;

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    console.log("🌐 Launching headless Chrome...");
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--no-zygote",
        "--single-process",
      ],
    });
    console.log("✅ Chrome launched");
  }
  return browser;
}

async function fetchWithBrowser(url) {
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-GB,en;q=0.9" });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    await new Promise(r => setTimeout(r, 2000)); // wait for JS to render
    const content = await page.content();
    return content;
  } finally {
    await page.close();
  }
}

// ─── DISCORD ───────────────────────────────────────────────────────────────

async function sendEmbed(webhookUrl, payload) {
  if (!webhookUrl || webhookUrl.startsWith("YOUR_")) return;
  try { await axios.post(webhookUrl, payload, { timeout: 8000 }); }
  catch (err) { console.warn(`  ⚠️  Discord error: ${err.message}`); }
}

function buildEmbed({ color, title, url, fields, footer }) {
  return { color, title, url, fields, footer: { text: footer }, timestamp: new Date().toISOString() };
}

async function alertInStock(webhook, retailer, name, url, price) {
  await sendEmbed(webhook, {
    content: "@everyone 🚨 **IN STOCK — ACT FAST!** 🚨",
    embeds: [buildEmbed({
      color: retailer.color,
      title: `${retailer.emoji} IN STOCK: ${name}`,
      url,
      fields: [
        { name: "💰 Price", value: price || "Check site", inline: true },
        { name: "🏪 Retailer", value: retailer.name, inline: true },
        { name: "🔗 Buy Now", value: `[Click here to buy](${url})`, inline: false },
      ],
      footer: "PokéMonitor UK • Stock can go in seconds!"
    })]
  });
}

async function alertNewCategoryListing(webhook, retailer, name, url) {
  await sendEmbed(webhook, {
    content: `🆕 **New product spotted on ${retailer.name}!**`,
    embeds: [buildEmbed({
      color: 0x00b4d8,
      title: `🆕 NEW LISTING: ${name}`,
      url,
      fields: [
        { name: "🏪 Retailer", value: retailer.name, inline: true },
        { name: "🔗 View Product", value: `[Click here](${url})`, inline: false },
      ],
      footer: "PokéMonitor UK • New product detected!"
    })]
  });
}

async function alertNewProductListing(webhook, retailer, name, url, inStock, price) {
  if (inStock) { await alertInStock(webhook, retailer, name, url, price); return; }
  await sendEmbed(webhook, {
    content: null,
    embeds: [buildEmbed({
      color: 0x00b4d8,
      title: `🆕 New listing spotted: ${name}`,
      url,
      fields: [
        { name: "🏪 Retailer", value: retailer.name, inline: true },
        { name: "📦 Status", value: "Not yet in stock — monitoring...", inline: true },
        { name: "🔗 View", value: `[View product](${url})`, inline: false },
      ],
      footer: "PokéMonitor UK • We'll @everyone when it's available"
    })]
  });
}

// ─── RETAILER CONFIGS ──────────────────────────────────────────────────────

const RETAILERS = {
  argos:        { name: "Argos",          emoji: "🛒", color: 0xe2001a },
  smyths:       { name: "Smyths Toys",    emoji: "🧸", color: 0xe8000b },
  very:         { name: "Very",           emoji: "🛍️", color: 0x7b2d8b },
  game:         { name: "GAME",           emoji: "🎮", color: 0xe20074 },
  pokemoncenter:{ name: "Pokémon Center", emoji: "🔴", color: 0xff0000 },
};

const CATEGORY_URLS = {
  argos:         "https://www.argos.co.uk/browse/toys/family-games/trading-cards-and-card-games/c:30425/brands:pokemon/",
  smyths:        "https://www.smythstoys.com/uk/en-gb/trading-cards/pokemon/c/SM010501",
  very:          "https://www.very.co.uk/sports-leisure/trading-cards/pokemon/e/b/4294966638.end",
  game:          "https://www.game.co.uk/en/trading-card-games/pokemon",
  pokemoncenter: "https://www.pokemoncenter.com/en-gb/category/trading-card-game",
};

// ─── STOCK CHECKERS ────────────────────────────────────────────────────────

async function checkStock(retailerKey, url) {
  const html = await fetchWithBrowser(url);
  const $ = cheerio.load(html);

  let inStock = false;
  let title = "";
  let price = "";

  switch (retailerKey) {
    case "argos":
      title = $("h1[data-test='product-title'], h1").first().text().trim();
      price = $("[data-test='product-price']").first().text().trim();
      inStock = $("button[data-test='add-to-trolley-button'], button[data-test='reserve-button']").length > 0
             && $("[data-test='out-of-stock']").length === 0;
      break;
    case "smyths":
      title = $("h1.pdp-title, h1.product-title, h1").first().text().trim();
      price = $(".pdp-price, .product-price").first().text().trim();
      inStock = $("button.add-to-cart-btn, button[data-interaction='add-to-cart']").length > 0
             && $(".out-of-stock, .js-out-of-stock").length === 0;
      break;
    case "very":
      title = $("h1.product-title, h1[itemprop='name'], h1").first().text().trim();
      price = $(".product-price, [itemprop='price']").first().text().trim();
      inStock = $("button.add-to-basket, .addToBasket button").length > 0
             && $(".out-of-stock, [class*='outOfStock']").length === 0;
      break;
    case "game":
      title = $("h1.product-name, h1.pdp-title, h1").first().text().trim();
      price = $(".product-price, .price").first().text().trim();
      inStock = $("button.add-to-basket, button[data-action='add-to-basket']").length > 0
             && $(".out-of-stock, .not-available").length === 0;
      break;
    case "pokemoncenter":
      title = $("h1.product-name, h1[class*='ProductName'], h1").first().text().trim();
      price = $(".product-price, [class*='ProductPrice']").first().text().trim();
      inStock = $("button.add-to-cart, button[data-testid='add-to-cart']").length > 0
             && $(".out-of-stock, .sold-out, [class*='outOfStock']").length === 0;
      break;
  }

  return { inStock, title, price };
}

// ─── CATEGORY SCRAPER ──────────────────────────────────────────────────────

async function scrapeCategory(retailerKey) {
  const url = CATEGORY_URLS[retailerKey];
  const html = await fetchWithBrowser(url);
  const $ = cheerio.load(html);
  const products = [];

  switch (retailerKey) {
    case "argos":
      $("a[href*='/product/']").each((_, el) => {
        const href = $(el).attr("href");
        const match = href && href.match(/\/product\/(\d+)/);
        if (match) {
          const id = match[1];
          const name = $(el).text().trim() || `Product ${id}`;
          if (!products.find(p => p.id === id)) {
            products.push({ id, name, url: `https://www.argos.co.uk/product/${id}` });
          }
        }
      });
      break;

    case "smyths":
      $("a[href*='/p/']").each((_, el) => {
        const href = $(el).attr("href");
        if (!href) return;
        const id = href.split("/p/")[1]?.split("/")[0];
        if (!id) return;
        const name = $(el).find("h3, .product-name, p").first().text().trim() || $(el).attr("title") || id;
        const purl = href.startsWith("http") ? href : `https://www.smythstoys.com${href}`;
        if (!products.find(p => p.id === id)) products.push({ id, name, url: purl });
      });
      break;

    case "very":
      $("a[href]").each((_, el) => {
        const href = $(el).attr("href");
        if (!href || !href.includes("/p/")) return;
        const name = $(el).find("h3, .productTitle, [class*='title']").first().text().trim() || $(el).attr("title") || "";
        if (!name) return;
        const id = href.split("/").filter(Boolean).pop();
        const purl = href.startsWith("http") ? href : `https://www.very.co.uk${href}`;
        if (id && !products.find(p => p.id === id)) products.push({ id, name, url: purl });
      });
      break;

    case "game":
      $("a[href]").each((_, el) => {
        const href = $(el).attr("href");
        if (!href) return;
        const name = $(el).find("h3, .productName, [class*='name']").first().text().trim() || $(el).attr("title") || "";
        if (!name || name.length < 5) return;
        const id = href.split("/").filter(Boolean).pop();
        const purl = href.startsWith("http") ? href : `https://www.game.co.uk${href}`;
        if (id && !products.find(p => p.id === id)) products.push({ id, name, url: purl });
      });
      break;

    case "pokemoncenter":
      $("a[href*='/product/']").each((_, el) => {
        const href = $(el).attr("href");
        if (!href) return;
        const name = $(el).find("h3, [class*='name'], [class*='title']").first().text().trim() || $(el).attr("title") || "";
        if (!name) return;
        const id = href.split("/").filter(Boolean).pop();
        const purl = href.startsWith("http") ? href : `https://www.pokemoncenter.com${href}`;
        if (id && !products.find(p => p.id === id)) products.push({ id, name, url: purl });
      });
      break;
  }

  return products;
}

// ─── MAIN CHECK LOGIC ──────────────────────────────────────────────────────

async function checkCategory(retailerKey, config, state) {
  const retailer = RETAILERS[retailerKey];
  const webhook = config.discord_webhooks?.[retailerKey];
  const stateKey = `category::${retailerKey}`;

  try {
    console.log(`  📋 Scanning ${retailer.name} category...`);
    const products = await scrapeCategory(retailerKey);

    if (products.length === 0) {
      console.log(`  ⚠️  [${retailer.name}] No products found on category page`);
      return;
    }

    console.log(`  ✅ [${retailer.name}] ${products.length} products found`);
    const previousIds = new Set(state[stateKey] || []);
    const newProducts = products.filter(p => !previousIds.has(p.id));

    for (const product of newProducts) {
      console.log(`  🆕 [${retailer.name}] New: ${product.name}`);
      await alertNewCategoryListing(webhook, retailer, product.name, product.url);
      await new Promise(r => setTimeout(r, 1000));
    }

    state[stateKey] = products.map(p => p.id);
  } catch (err) {
    console.warn(`  ⚠️  [${retailer.name}] Category error: ${err.message}`);
  }
}

async function checkProduct(product, retailerKey, config, state) {
  const retailer = RETAILERS[retailerKey];
  if (!retailer) return;
  const url = product.urls[retailerKey];
  if (!url || url.includes("PASTE_PRODUCT_URL_HERE")) return;

  const stateKey = `${retailerKey}::${url}`;
  const webhook = config.discord_webhooks?.[retailerKey];
  const previousState = state[stateKey];

  try {
    const { inStock, title, price } = await checkStock(retailerKey, url);
    console.log(`  ${inStock ? "✅" : "❌"} [${retailer.name}] ${title || product.name}${price ? ` — ${price}` : ""}`);

    if (previousState === undefined) {
      await alertNewProductListing(webhook, retailer, title || product.name, url, inStock, price);
    } else if (inStock && previousState === false) {
      console.log(`  🚨 RESTOCK!`);
      await alertInStock(webhook, retailer, title || product.name, url, price);
    }
    state[stateKey] = inStock;
  } catch (err) {
    console.warn(`  ⚠️  [${retailer.name}] ${product.name}: ${err.message}`);
  }
}

// ─── MAIN LOOP ─────────────────────────────────────────────────────────────

async function runChecks(config, state) {
  console.log(`\n🔍 Check cycle — ${new Date().toLocaleTimeString("en-GB")}\n`);

  console.log("📋 Scanning category pages...");
  for (const key of Object.keys(RETAILERS)) {
    await checkCategory(key, config, state);
    await new Promise(r => setTimeout(r, 3000));
  }

  if (config.products?.length > 0) {
    console.log(`\n📦 Checking ${config.products.length} individual products...`);
    for (const product of config.products) {
      console.log(`📦 ${product.name}`);
      for (const key of product.retailers) {
        await checkProduct(product, key, config, state);
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }

  saveState(state);
  console.log(`\n✔️  Done. Next check in ${config.check_interval_seconds || 90}s`);
}

function startKeepAlive() {
  http.createServer((req, res) => {
    res.writeHead(200); res.end("PokéMonitor UK running 🟢\n");
  }).listen(KEEPALIVE_PORT, () => console.log(`🌐 Keep-alive on port ${KEEPALIVE_PORT}`));
}

async function main() {
  console.log("╔══════════════════════════════════════╗");
  console.log("║       PokéMonitor UK  v1.3           ║");
  console.log("║  Headless Chrome Edition 🇬🇧          ║");
  console.log("╚══════════════════════════════════════╝\n");

  const config = loadConfig();
  const state = loadState();
  const intervalMs = (config.check_interval_seconds || 90) * 1000;
  const configured = Object.entries(config.discord_webhooks || {}).filter(([,v]) => v && !v.startsWith("YOUR_"));
  console.log(`✅ ${configured.length}/5 webhooks configured\n`);

  // Pre-launch browser
  await getBrowser();

  startKeepAlive();
  await runChecks(config, state);
  setInterval(() => runChecks(config, state), intervalMs);
}

main().catch(err => { console.error("💥 Fatal:", err); process.exit(1); });
