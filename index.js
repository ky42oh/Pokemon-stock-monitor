const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const http = require("http");
const puppeteer = require("puppeteer-core");

axios.defaults.maxRedirects = 5;

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

let browser = null;

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    console.log("🌐 Launching headless Chrome...");
    const paths = ["/usr/bin/google-chrome","/usr/bin/google-chrome-stable","/usr/bin/chromium","/usr/bin/chromium-browser"];
    const executablePath = paths.find(p => fs.existsSync(p));
    if (!executablePath) throw new Error("Chrome not found");
    browser = await puppeteer.launch({
      executablePath,
      headless: "new",
      args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage",
             "--disable-gpu","--no-first-run","--no-zygote","--single-process"],
    });
    console.log("✅ Chrome launched");
  }
  return browser;
}

async function fetchPage(url, waitMs = 3000) {
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-GB,en;q=0.9" });
    await page.setRequestInterception(true);
    page.on("request", req => {
      if (["image","font","media"].includes(req.resourceType())) req.abort();
      else req.continue();
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    await new Promise(r => setTimeout(r, waitMs));
    return await page.content();
  } finally {
    await page.close();
  }
}

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

async function alertNewListing(webhook, retailer, name, url, inStock, price) {
  if (inStock) { await alertInStock(webhook, retailer, name, url, price); return; }
  await sendEmbed(webhook, {
    content: `🆕 **New product spotted on ${retailer.name}!**`,
    embeds: [buildEmbed({
      color: 0x00b4d8,
      title: `🆕 NEW LISTING: ${name}`,
      url,
      fields: [
        { name: "🏪 Retailer", value: retailer.name, inline: true },
        { name: "💰 Price", value: price || "Check site", inline: true },
        { name: "📦 Status", value: "Out of stock — monitoring...", inline: false },
        { name: "🔗 View", value: `[Click here](${url})`, inline: false },
      ],
      footer: "PokéMonitor UK • We'll @everyone when it's available"
    })]
  });
}

const RETAILERS = {
  argos:         { name: "Argos",          emoji: "🛒", color: 0xe2001a },
  smyths:        { name: "Smyths Toys",    emoji: "🧸", color: 0xe8000b },
  very:          { name: "Very",           emoji: "🛍️", color: 0x7b2d8b },
  game:          { name: "GAME",           emoji: "🎮", color: 0xe20074 },
  pokemoncenter: { name: "Pokémon Center", emoji: "🔴", color: 0xff0000 },
};

const CATEGORY_URLS = {
  argos:         "https://www.argos.co.uk/browse/toys/family-games/trading-cards-and-card-games/c:30425/brands:pokemon/",
  smyths:        "https://www.smythstoys.com/uk/en-gb/brand/pokemon/pokemon-trading-card-game/c/SM0601011202",
  very:          "https://www.very.co.uk/sports-leisure/trading-cards/pokemon/e/b/4294966638.end",
  game:          "https://www.game.co.uk/en/trading-card-games/pokemon",
  pokemoncenter: "https://www.pokemoncenter.com/en-gb/category/trading-card-game",
};

const SEARCH_URLS = {
  argos:         "https://www.argos.co.uk/search/pokemon+trading+card/",
  smyths:        "https://www.smythstoys.com/uk/en-gb/search/?q=pokemon+trading+card",
  very:          "https://www.very.co.uk/search?q=pokemon+trading+card",
  game:          "https://www.game.co.uk/en/search?q=pokemon+card",
  pokemoncenter: "https://www.pokemoncenter.com/en-gb/search?q=trading+card",
};

const JUNK = new Set([
  "sign in","my bag","my wish list","wishlist","basket","checkout",
  "download on the apple store","download on the google play store",
  "help","stores","search","account","login","register",
  "cookie","privacy","terms","delivery","returns","contact","menu","home","back"
]);

function isJunk(name) {
  if (!name || name.length < 5) return true;
  return JUNK.has(name.toLowerCase().trim());
}

function isPokemon(name) {
  const n = name.toLowerCase();
  return n.includes("pok") || n.includes("tcg") || n.includes("trading card") ||
         n.includes("booster") || n.includes("elite trainer") || n.includes("etb") ||
         n.includes("mega evolution") || n.includes("scarlet") || n.includes("violet");
}

function extractProducts(retailerKey, $) {
  const products = [];

  if (retailerKey === "argos") {
    $("a[href*='/product/']").each((_, el) => {
      const href = $(el).attr("href");
      const match = href && href.match(/\/product\/(\d+)/);
      if (!match) return;
      const id = match[1];
      const parent = $(el).closest("[class*='product'],[class*='card'],li,article");
      const name = parent.find("h2,h3,[class*='title'],[class*='name']").first().text().trim() || $(el).text().trim() || `Product ${id}`;
      if (isJunk(name)) return;
      const price = parent.find("[class*='price'],[data-test*='price']").first().text().trim();
      const outOfStock = parent.find("[class*='out-of-stock'],[class*='unavailable'],[class*='OutOfStock']").length > 0;
      const addBtn = parent.find("button[class*='add'],button[class*='trolley'],button[class*='basket']").length > 0;
      const inStock = addBtn && !outOfStock;
      const url = `https://www.argos.co.uk/product/${id}`;
      if (!products.find(p => p.id === id)) products.push({ id, name, url, inStock, price });
    });
  }

  else if (retailerKey === "smyths") {
    $("a[href*='/p/']").each((_, el) => {
      const href = $(el).attr("href");
      if (!href || !href.includes("/uk/en-gb/")) return;
      const match = href.match(/\/p\/(\d+)/);
      if (!match) return;
      const id = match[1];
      const parent = $(el).closest("[class*='product'],[class*='card'],li,article");
      const name = parent.find("p,h3,[class*='name'],[class*='title']").first().text().trim() || $(el).attr("title") || `Smyths ${id}`;
      if (isJunk(name)) return;
      const url = `https://www.smythstoys.com${href.split("?")[0]}`;
      const price = parent.find("[class*='price']").first().text().trim();
      const outOfStock = parent.find("[class*='out-of-stock'],[class*='unavailable']").length > 0;
      const addBtn = parent.find("button[class*='add'],button[class*='cart']").length > 0;
      const inStock = addBtn && !outOfStock;
      if (!products.find(p => p.id === id)) products.push({ id, name, url, inStock, price });
    });
  }

  else if (retailerKey === "very") {
    $("a[href]").each((_, el) => {
      const href = $(el).attr("href");
      if (!href) return;
      const parent = $(el).closest("[class*='product'],[class*='card'],li,article");
      const name = parent.find("h3,[class*='title'],[class*='name']").first().text().trim() || $(el).attr("title") || "";
      if (isJunk(name) || !isPokemon(name)) return;
      const id = href.split("/").filter(Boolean).pop().split("?")[0];
      const url = href.startsWith("http") ? href : `https://www.very.co.uk${href}`;
      const price = parent.find("[class*='price']").first().text().trim();
      const outOfStock = parent.find("[class*='out-of-stock'],[class*='unavailable']").length > 0;
      const addBtn = parent.find("button[class*='add'],button[class*='basket']").length > 0;
      const inStock = addBtn && !outOfStock;
      if (id && !products.find(p => p.id === id)) products.push({ id, name, url, inStock, price });
    });
  }

  else if (retailerKey === "game") {
    $("a[href]").each((_, el) => {
      const href = $(el).attr("href");
      if (!href) return;
      const parent = $(el).closest("[class*='product'],[class*='card'],li,article");
      const name = parent.find("h3,[class*='name'],[class*='title']").first().text().trim() || $(el).attr("title") || "";
      if (isJunk(name) || !isPokemon(name)) return;
      const id = href.split("/").filter(Boolean).pop().split("?")[0];
      if (!id || id.length < 3) return;
      const url = href.startsWith("http") ? href : `https://www.game.co.uk${href}`;
      const price = parent.find("[class*='price']").first().text().trim();
      const outOfStock = parent.find("[class*='out-of-stock'],[class*='unavailable']").length > 0;
      const addBtn = parent.find("button[class*='add'],button[class*='basket']").length > 0;
      const inStock = addBtn && !outOfStock;
      if (!products.find(p => p.id === id)) products.push({ id, name, url, inStock, price });
    });
  }

  else if (retailerKey === "pokemoncenter") {
    $("a[href]").each((_, el) => {
      const href = $(el).attr("href");
      if (!href || (!href.includes("/product/") && !href.includes("/en-gb/"))) return;
      const parent = $(el).closest("[class*='product'],[class*='card'],li,article");
      const name = parent.find("h3,[class*='name'],[class*='title']").first().text().trim() || $(el).attr("title") || "";
      if (isJunk(name) || !isPokemon(name)) return;
      const id = href.split("/").filter(Boolean).pop().split("?")[0];
      const url = href.startsWith("http") ? href : `https://www.pokemoncenter.com${href}`;
      const price = parent.find("[class*='price']").first().text().trim();
      const outOfStock = parent.find("[class*='out-of-stock'],[class*='sold-out']").length > 0;
      const addBtn = parent.find("button[class*='add'],button[class*='cart']").length > 0;
      const inStock = addBtn && !outOfStock;
      if (id && !products.find(p => p.id === id)) products.push({ id, name, url, inStock, price });
    });
  }

  return products;
}

async function monitorPage(retailerKey, pageUrl, pageType, config, state) {
  const retailer = RETAILERS[retailerKey];
  const webhook = config.discord_webhooks?.[retailerKey];
  const listStateKey = `${pageType}::${retailerKey}`;
  try {
    console.log(`  📋 [${retailer.name}] ${pageType}...`);
    const html = await fetchPage(pageUrl, 3000);
    const $ = cheerio.load(html);
    const products = extractProducts(retailerKey, $);

    if (products.length === 0) { console.log(`  ⚠️  [${retailer.name}] No products on ${pageType}`); return; }
    console.log(`  ✅ [${retailer.name}] ${products.length} products on ${pageType}`);

    const previousIds = new Set(state[listStateKey] || []);

    for (const product of products) {
      const productStateKey = `product::${retailerKey}::${product.id}`;
      const previousInStock = state[productStateKey];

      if (!previousIds.has(product.id)) {
        console.log(`  🆕 [${retailer.name}] New: ${product.name}${product.inStock ? " 🟢" : ""}`);
        await alertNewListing(webhook, retailer, product.name, product.url, product.inStock, product.price);
      } else if (product.inStock && previousInStock === false) {
        console.log(`  🚨 [${retailer.name}] RESTOCK: ${product.name}`);
        await alertInStock(webhook, retailer, product.name, product.url, product.price);
      } else {
        console.log(`  ${product.inStock ? "✅" : "❌"} [${retailer.name}] ${product.name}`);
      }

      state[productStateKey] = product.inStock;
      await new Promise(r => setTimeout(r, 500));
    }

    state[listStateKey] = products.map(p => p.id);
  } catch (err) {
    console.warn(`  ⚠️  [${retailer.name}] ${pageType} error: ${err.message}`);
  }
}

async function checkIndividualProduct(product, retailerKey, config, state) {
  const retailer = RETAILERS[retailerKey];
  if (!retailer) return;
  const url = product.urls?.[retailerKey];
  if (!url || url.includes("PASTE_PRODUCT_URL_HERE")) return;
  const stateKey = `individual::${retailerKey}::${url}`;
  const webhook = config.discord_webhooks?.[retailerKey];
  const previousState = state[stateKey];
  try {
    const html = await fetchPage(url, 2000);
    const $ = cheerio.load(html);
    let inStock = false, title = "", price = "";
    switch (retailerKey) {
      case "argos":
        title = $("h1[data-test='product-title'],h1").first().text().trim();
        price = $("[data-test='product-price']").first().text().trim();
        inStock = $("button[data-test='add-to-trolley-button'],button[data-test='reserve-button']").length > 0 && $("[data-test='out-of-stock']").length === 0;
        break;
      case "smyths":
        title = $("h1.pdp-title,h1").first().text().trim();
        price = $("[class*='price']").first().text().trim();
        inStock = $("button[class*='add'],button[class*='cart']").length > 0 && $("[class*='out-of-stock']").length === 0;
        break;
      case "very":
        title = $("h1").first().text().trim();
        price = $("[class*='price'],[itemprop='price']").first().text().trim();
        inStock = $("button[class*='basket']").length > 0 && $("[class*='outOfStock']").length === 0;
        break;
      case "game":
        title = $("h1").first().text().trim();
        price = $("[class*='price']").first().text().trim();
        inStock = $("button[class*='basket']").length > 0 && $("[class*='out-of-stock']").length === 0;
        break;
      case "pokemoncenter":
        title = $("h1").first().text().trim();
        price = $("[class*='price']").first().text().trim();
        inStock = $("button[class*='cart']").length > 0 && $("[class*='outOfStock'],[class*='sold-out']").length === 0;
        break;
    }
    const icon = inStock ? "✅" : "❌";
    console.log(`  ${icon} [${retailer.name}] ${title || product.name}${price ? ` — ${price}` : ""}`);
    if (previousState === undefined) {
      await alertNewListing(webhook, retailer, title || product.name, url, inStock, price);
    } else if (inStock && previousState === false) {
      console.log(`  🚨 RESTOCK!`);
      await alertInStock(webhook, retailer, title || product.name, url, price);
    }
    state[stateKey] = inStock;
  } catch (err) {
    console.warn(`  ⚠️  [${retailer.name}] ${product.name}: ${err.message}`);
  }
}

async function runChecks(config, state) {
  console.log(`\n🔍 Check cycle — ${new Date().toLocaleTimeString("en-GB")}\n`);

  console.log("━━━ CATEGORY PAGES ━━━");
  for (const key of Object.keys(RETAILERS)) {
    await monitorPage(key, CATEGORY_URLS[key], "category", config, state);
    await new Promise(r => setTimeout(r, 3000));
  }

  console.log("\n━━━ SEARCH PAGES ━━━");
  for (const key of Object.keys(RETAILERS)) {
    await monitorPage(key, SEARCH_URLS[key], "search", config, state);
    await new Promise(r => setTimeout(r, 3000));
  }

  if (config.products?.length > 0) {
    console.log(`\n━━━ INDIVIDUAL PRODUCTS (${config.products.length}) ━━━`);
    for (const product of config.products) {
      console.log(`📦 ${product.name}`);
      for (const key of product.retailers) {
        await checkIndividualProduct(product, key, config, state);
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
  console.log("║       PokéMonitor UK  v1.5           ║");
  console.log("║  Headless Chrome Edition 🇬🇧          ║");
  console.log("╚══════════════════════════════════════╝\n");
  const config = loadConfig();
  const state = loadState();
  const intervalMs = (config.check_interval_seconds || 90) * 1000;
  const configured = Object.entries(config.discord_webhooks || {}).filter(([,v]) => v && !v.startsWith("YOUR_"));
  console.log(`✅ ${configured.length}/5 webhooks configured\n`);
  await getBrowser();
  startKeepAlive();
  await runChecks(config, state);
  setInterval(() => runChecks(config, state), intervalMs);
}

main().catch(err => { console.error("💥 Fatal:", err); process.exit(1); });
