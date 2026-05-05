const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const http = require("http");
axios.defaults.maxRedirects = 5;
axios.defaults.followRedirect = true;
// ─── CONFIG & STATE ────────────────────────────────────────────────────────

const CONFIG_FILE = "config.json";
const STATE_FILE = "stock_state.json";
const KEEPALIVE_PORT = 3000;

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    console.error("❌ config.json not found. Copy config.example.json to config.json and fill in your details.");
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch { return {}; }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ─── SHARED HEADERS ────────────────────────────────────────────────────────

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-GB,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
  "DNT": "1",
};

// ─── RETAILER DEFINITIONS ──────────────────────────────────────────────────

const RETAILERS = {
  smyths: {
    name: "Smyths Toys",
    emoji: "🧸",
    color: 0xe8000b,
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
  argos: {
    name: "Argos",
    emoji: "🛒",
    color: 0xe2001a,
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
  very: {
    name: "Very",
    emoji: "🛍️",
    color: 0x7b2d8b,
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
    name: "GAME",
    emoji: "🎮",
    color: 0xe20074,
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
    name: "Pokémon Center",
    emoji: "🔴",
    color: 0xff0000,
    check: async (url) => {
      const res = await axios.get(url, { headers: HEADERS, timeout: 12000 });
      const $ = cheerio.load(res.data);
      const btn = $("button.add-to-cart, button[data-testid='add-to-cart'], .add-to-cart-button").first();
      const outOfStock = $(".out-of-stock, .sold-out, [class*='outOfStock'], [class*='SoldOut']").length > 0;
      const inStock = btn.length > 0 && !btn.prop("disabled") && !outOfStock;
      const title = $("h1.product-name, h1[class*='ProductName'], h1").first().text().trim();
      const price = $(".product-price, [class*='ProductPrice']").first().text().trim();
      return { inStock, title, price };
    }
  }
};

// ─── DISCORD ALERTS ────────────────────────────────────────────────────────

async function sendEmbed(webhookUrl, payload) {
  if (!webhookUrl || webhookUrl.startsWith("YOUR_")) {
    console.warn("  ⚠️  Webhook not configured for this retailer — skipping.");
    return;
  }
  try {
    await axios.post(webhookUrl, payload, { timeout: 8000 });
  } catch (err) {
    console.warn(`  ⚠️  Discord error: ${err.message}`);
  }
}

async function alertInStock(webhook, retailer, product, stockInfo) {
  await sendEmbed(webhook, {
    content: "@everyone 🚨 **IN STOCK — ACT FAST!** 🚨",
    embeds: [{
      color: retailer.color,
      title: `${retailer.emoji} IN STOCK: ${stockInfo.title || product.name}`,
      url: stockInfo.url,
      fields: [
        { name: "💰 Price", value: stockInfo.price || "Check site", inline: true },
        { name: "🏪 Retailer", value: retailer.name, inline: true },
        { name: "🔗 Buy Now", value: `[Click here to buy](${stockInfo.url})`, inline: false },
      ],
      footer: { text: "PokéMonitor UK • Stock can go in seconds!" },
      timestamp: new Date().toISOString()
    }]
  });
}

async function alertNewProductInStock(webhook, retailer, product, stockInfo) {
  await sendEmbed(webhook, {
    content: `🆕 @everyone **NEW PRODUCT — AND IT'S IN STOCK!**`,
    embeds: [{
      color: 0x00b4d8,
      title: `🆕 NEW & IN STOCK: ${stockInfo.title || product.name}`,
      url: stockInfo.url,
      fields: [
        { name: "💰 Price", value: stockInfo.price || "Check site", inline: true },
        { name: "🏪 Retailer", value: retailer.name, inline: true },
        { name: "🔗 Buy Now", value: `[Click here](${stockInfo.url})`, inline: false },
      ],
      footer: { text: "PokéMonitor UK • Brand new listing spotted!" },
      timestamp: new Date().toISOString()
    }]
  });
}

async function alertNewProductOutOfStock(webhook, retailer, product, stockInfo) {
  // New product spotted but not in stock yet — quietly log, send a low-key notice
  await sendEmbed(webhook, {
    content: null,
    embeds: [{
      color: 0x888888,
      title: `🆕 New listing spotted (out of stock): ${stockInfo.title || product.name}`,
      url: stockInfo.url,
      fields: [
        { name: "🏪 Retailer", value: retailer.name, inline: true },
        { name: "📦 Status", value: "Not yet in stock — monitoring...", inline: true },
        { name: "🔗 Link", value: `[View product](${stockInfo.url})`, inline: false },
      ],
      footer: { text: "PokéMonitor UK • We'll ping @everyone when it's available" },
      timestamp: new Date().toISOString()
    }]
  });
}

// ─── CORE CHECK LOGIC ──────────────────────────────────────────────────────

async function checkProduct(product, retailerKey, config, state) {
  const retailer = RETAILERS[retailerKey];
  if (!retailer) return;

  const url = product.urls[retailerKey];
  if (!url || url.includes("your-product-url-here")) return;

  const stateKey = `${retailerKey}::${url}`;
  const webhook = config.discord_webhooks?.[retailerKey];
  const previousState = state[stateKey]; // undefined = brand new, true/false = known

  try {
    const result = await retailer.check(url);
    const stockInfo = { ...result, url };
    const { inStock, title, price } = stockInfo;

    const icon = inStock ? "✅" : "❌";
    console.log(`  ${icon} [${retailer.name}] ${title || product.name}${price ? ` — ${price}` : ""}`);

    if (previousState === undefined) {
      // First time we've seen this product
      if (inStock) {
        console.log(`  🆕🚨 New product AND in stock — alerting!`);
        await alertNewProductInStock(webhook, retailer, product, stockInfo);
      } else {
        console.log(`  🆕 New product detected — out of stock, watching...`);
        await alertNewProductOutOfStock(webhook, retailer, product, stockInfo);
      }
    } else if (inStock && previousState === false) {
      // Was out of stock, now back in — the main event!
      console.log(`  🚨 RESTOCK DETECTED — alerting!`);
      await alertInStock(webhook, retailer, product, stockInfo);
    }
    // If it was in stock and still is, or still out of stock — do nothing

    state[stateKey] = inStock;

  } catch (err) {
    console.warn(`  ⚠️  [${retailer.name}] ${product.name}: ${err.message}`);
  }
}

// ─── MAIN LOOP ─────────────────────────────────────────────────────────────

async function runChecks(config, state) {
  const now = new Date().toLocaleTimeString("en-GB");
  console.log(`\n🔍 Check cycle — ${now} | ${config.products.length} product(s)\n`);

  for (const product of config.products) {
    console.log(`📦 ${product.name}`);
    for (const retailerKey of product.retailers) {
      await checkProduct(product, retailerKey, config, state);
      await new Promise(r => setTimeout(r, 1500)); // polite delay between requests
    }
  }

  saveState(state);
  const interval = config.check_interval_seconds || 90;
  console.log(`\n✔️  Done. Next check in ${interval}s`);
}

// ─── KEEP-ALIVE (stops Replit sleeping) ────────────────────────────────────

function startKeepAlive() {
  http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("PokéMonitor UK is running 🟢\n");
  }).listen(KEEPALIVE_PORT, () => {
    console.log(`🌐 Keep-alive server running on port ${KEEPALIVE_PORT}`);
  });
}

// ─── ENTRY POINT ───────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════╗");
  console.log("║       PokéMonitor UK  v1.1           ║");
  console.log("║   Discord Stock Alert Bot 🇬🇧         ║");
  console.log("╚══════════════════════════════════════╝\n");

  const config = loadConfig();
  const state = loadState();
  const intervalMs = (config.check_interval_seconds || 90) * 1000;

  const webhooks = config.discord_webhooks || {};
  const configured = Object.entries(webhooks).filter(([, v]) => v && !v.startsWith("YOUR_"));
  console.log(`✅ ${configured.length}/5 Discord webhook(s) configured\n`);
  if (configured.length === 0) console.warn("⚠️  No webhooks set — no Discord alerts will fire!\n");

  startKeepAlive();
  await runChecks(config, state);
  setInterval(() => runChecks(config, state), intervalMs);
}

main().catch(err => {
  console.error("💥 Fatal error:", err);
  process.exit(1);
});
