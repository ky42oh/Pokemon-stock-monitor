const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const http = require("http");

axios.defaults.maxRedirects = 5;
axios.defaults.followRedirect = true;

const CONFIG_FILE = "config.json";
const STATE_FILE = "stock_state.json";
const KEEPALIVE_PORT = 3000;

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) { console.error("❌ config.json not found."); process.exit(1); }
  return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
}
function loadState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}
function saveState(state) { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-GB,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
  "DNT": "1",
};

// ─── CATEGORY SCRAPERS ─────────────────────────────────────────────────────

const CATEGORY_SCRAPERS = {
  argos: {
    name: "Argos", emoji: "🛒", color: 0xe2001a,
    url: "https://www.argos.co.uk/browse/toys/family-games/trading-cards-and-card-games/c:30425/brands:pokemon/",
    scrape: ($) => {
      const products = [];
      $("a[href*='/product/']").each((_, el) => {
        const href = $(el).attr("href");
        const match = href && href.match(/\/product\/(\d+)/);
        if (match) {
          const id = match[1];
          const name = $(el).text().trim() || `Product ${id}`;
          const url = `https://www.argos.co.uk/product/${id}`;
          if (!products.find(p => p.id === id)) products.push({ id, name, url });
        }
      });
      return products;
    }
  },
  smyths: {
    name: "Smyths Toys", emoji: "🧸", color: 0xe8000b,
    url: "https://www.smythstoys.com/uk/en-gb/trading-cards/pokemon/c/SM010501",
    scrape: ($) => {
      const products = [];
      $("a[href*='/uk/en-gb/']").each((_, el) => {
        const href = $(el).attr("href");
        if (href && href.includes("/p/")) {
          const name = $(el).find(".product-name, h3, .title").first().text().trim() || $(el).attr("title") || href.split("/").pop();
          const url = href.startsWith("http") ? href : `https://www.smythstoys.com${href}`;
          const id = href.split("/p/")[1]?.split("/")[0] || href;
          if (id && !products.find(p => p.id === id)) products.push({ id, name, url });
        }
      });
      return products;
    }
  },
  very: {
    name: "Very", emoji: "🛍️", color: 0x7b2d8b,
    url: "https://www.very.co.uk/sports-leisure/trading-cards/pokemon/e/b/4294966638.end",
    scrape: ($) => {
      const products = [];
      $("a").each((_, el) => {
        const href = $(el).attr("href");
        if (!href) return;
        const name = $(el).find(".productTitle, .product-title, h3").first().text().trim() || $(el).attr("title") || "";
        if (!name) return;
        const url = href.startsWith("http") ? href : `https://www.very.co.uk${href}`;
        const id = href.split("/").filter(Boolean).pop();
        if (id && !products.find(p => p.id === id)) products.push({ id, name, url });
      });
      return products;
    }
  },
  game: {
    name: "GAME", emoji: "🎮", color: 0xe20074,
    url: "https://www.game.co.uk/en/trading-card-games/pokemon",
    scrape: ($) => {
      const products = [];
      $("a").each((_, el) => {
        const href = $(el).attr("href");
        if (!href) return;
        const name = $(el).find(".productName, .product-name, h3").first().text().trim() || $(el).attr("title") || "";
        if (!name) return;
        const url = href.startsWith("http") ? href : `https://www.game.co.uk${href}`;
        const id = href.split("/").filter(Boolean).pop();
        if (id && !products.find(p => p.id === id)) products.push({ id, name, url });
      });
      return products;
    }
  },
  pokemoncenter: {
    name: "Pokémon Center", emoji: "🔴", color: 0xff0000,
    url: "https://www.pokemoncenter.com/en-gb/category/trading-card-game",
    scrape: ($) => {
      const products = [];
      $("a[href*='/product/'], a[href*='/en-gb/']").each((_, el) => {
        const href = $(el).attr("href");
        if (!href || !href.includes("/product/")) return;
        const name = $(el).find(".product-name, h3, [class*='ProductName']").first().text().trim() || $(el).attr("title") || "";
        if (!name) return;
        const url = href.startsWith("http") ? href : `https://www.pokemoncenter.com${href}`;
        const id = href.split("/").filter(Boolean).pop();
        if (id && !products.find(p => p.id === id)) products.push({ id, name, url });
      });
      return products;
    }
  }
};

// ─── INDIVIDUAL PRODUCT CHECKERS ───────────────────────────────────────────

const RETAILERS = {
  argos: {
    name: "Argos", emoji: "🛒", color: 0xe2001a,
    check: async (url) => {
      const res = await axios.get(url, { headers: HEADERS, timeout: 12000 });
      const $ = cheerio.load(res.data);
      const btn = $("button[data-test='reserve-button'], button[data-test='add-to-trolley-button']").first();
      const outOfStock = $("[data-test='out-of-stock'], .out-of-stock-message").length > 0;
      const inStock = btn.length > 0 && !outOfStock;
      const title = $("h1[data-test='product-title'], h1").first().text().trim();
      const price = $("[data-test='product-price']").first().text().trim();
      return { inStock, title, price };
    }
  },
  smyths: {
    name: "Smyths Toys", emoji: "🧸", color: 0xe8000b,
    check: async (url) => {
      const res = await axios.get(url, { headers: HEADERS, timeout: 12000 });
      const $ = cheerio.load(res.data);
      const btn = $("button.add-to-cart-btn, button[data-interaction='add-to-cart']").first();
      const outOfStock = $(".out-of-stock, .js-out-of-stock").length > 0;
      const inStock = btn.length > 0 && !btn.prop("disabled") && !outOfStock;
      const title = $("h1.pdp-title, h1.product-title, h1").first().text().trim();
      const price = $(".pdp-price, .product-price").first().text().trim();
      return { inStock, title, price };
    }
  },
  very: {
    name: "Very", emoji: "🛍️", color: 0x7b2d8b,
    check: async (url) => {
      const res = await axios.get(url, { headers: HEADERS, timeout: 12000 });
      const $ = cheerio.load(res.data);
      const btn = $("button.add-to-basket, .addToBasket button").first();
      const outOfStock = $(".out-of-stock, .availability-out-of-stock, [class*='outOfStock']").length > 0;
      const inStock = btn.length > 0 && !btn.prop("disabled") && !outOfStock;
      const title = $("h1.product-title, h1[itemprop='name'], h1").first().text().trim();
      const price = $(".product-price, [itemprop='price']").first().text().trim();
      return { inStock, title, price };
    }
  },
  game: {
    name: "GAME", emoji: "🎮", color: 0xe20074,
    check: async (url) => {
      const res = await axios.get(url, { headers: HEADERS, timeout: 12000 });
      const $ = cheerio.load(res.data);
      const btn = $("button.add-to-basket, button[data-action='add-to-basket']").first();
      const outOfStock = $(".out-of-stock, .not-available").length > 0;
      const inStock = btn.length > 0 && !btn.prop("disabled") && !outOfStock;
      const title = $("h1.product-name, h1.pdp-title, h1").first().text().trim();
      const price = $(".product-price, .price").first().text().trim();
      return { inStock, title, price };
    }
  },
  pokemoncenter: {
    name: "Pokémon Center", emoji: "🔴", color: 0xff0000,
    check: async (url) => {
      const res = await axios.get(url, { headers: HEADERS, timeout: 12000 });
      const $ = cheerio.load(res.data);
      const btn = $("button.add-to-cart, button[data-testid='add-to-cart'], .add-to-cart-button").first();
      const outOfStock = $(".out-of-stock, .sold-out, [class*='outOfStock']").length > 0;
      const inStock = btn.length > 0 && !btn.prop("disabled") && !outOfStock;
      const title = $("h1.product-name, h1[class*='ProductName'], h1").first().text().trim();
      const price = $(".product-price, [class*='ProductPrice']").first().text().trim();
      return { inStock, title, price };
    }
  }
};

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
      footer: "PokéMonitor UK • New product detected on category page!"
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

// ─── CATEGORY CHECK ────────────────────────────────────────────────────────

async function checkCategory(retailerKey, config, state) {
  const scraper = CATEGORY_SCRAPERS[retailerKey];
  if (!scraper) return;
  const webhook = config.discord_webhooks?.[retailerKey];
  const stateKey = `category::${retailerKey}`;
  try {
    const res = await axios.get(scraper.url, { headers: HEADERS, timeout: 15000 });
    const $ = cheerio.load(res.data);
    const products = scraper.scrape($);
    if (products.length === 0) { console.log(`  ⚠️  [${scraper.name}] No products found on category page`); return; }
    console.log(`  📋 [${scraper.name}] ${products.length} products on category page`);
    const previousIds = new Set(state[stateKey] || []);
    const newProducts = products.filter(p => !previousIds.has(p.id));
    for (const product of newProducts) {
      console.log(`  🆕 [${scraper.name}] New: ${product.name}`);
      await alertNewCategoryListing(webhook, scraper, product.name, product.url);
      await new Promise(r => setTimeout(r, 1000));
    }
    state[stateKey] = products.map(p => p.id);
  } catch (err) {
    console.warn(`  ⚠️  [${scraper.name}] Category check error: ${err.message}`);
  }
}

// ─── PRODUCT CHECK ─────────────────────────────────────────────────────────

async function checkProduct(product, retailerKey, config, state) {
  const retailer = RETAILERS[retailerKey];
  if (!retailer) return;
  const url = product.urls[retailerKey];
  if (!url || url.includes("PASTE_PRODUCT_URL_HERE")) return;
  const stateKey = `${retailerKey}::${url}`;
  const webhook = config.discord_webhooks?.[retailerKey];
  const previousState = state[stateKey];
  try {
    const { inStock, title, price } = await retailer.check(url);
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
  for (const key of Object.keys(CATEGORY_SCRAPERS)) {
    await checkCategory(key, config, state);
    await new Promise(r => setTimeout(r, 2000));
  }

  if (config.products?.length > 0) {
    console.log(`\n📦 Checking ${config.products.length} individual products...`);
    for (const product of config.products) {
      console.log(`📦 ${product.name}`);
      for (const key of product.retailers) {
        await checkProduct(product, key, config, state);
        await new Promise(r => setTimeout(r, 2000));
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
  console.log("║       PokéMonitor UK  v1.2           ║");
  console.log("║   Discord Stock Alert Bot 🇬🇧         ║");
  console.log("╚══════════════════════════════════════╝\n");
  const config = loadConfig();
  const state = loadState();
  const intervalMs = (config.check_interval_seconds || 90) * 1000;
  const configured = Object.entries(config.discord_webhooks || {}).filter(([,v]) => v && !v.startsWith("YOUR_"));
  console.log(`✅ ${configured.length}/5 webhooks configured\n`);
  startKeepAlive();
  await runChecks(config, state);
  setInterval(() => runChecks(config, state), intervalMs);
}

main().catch(err => { console.error("💥 Fatal:", err); process.exit(1); });
