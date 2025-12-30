// Fix for undici ReferenceError: File is not defined
if (typeof File === 'undefined') {
  global.File = class File {
    constructor() {}
  };
}

const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

// ---- SCRAPERS ----
const { scrapeNovel: scrapeFreewebnovel } = require("./scrapers/freewebnovel");
const { scrapeNovel: scrapeRoyalroad } = require("./scrapers/royalroad");
const { scrapeNovel: scrapeWebnovel } = require("./scrapers/webnovel");
const { scrapeNovel: scrapeWattpad } = require("./scrapers/wattpad");
const { scrapeNovel: scrapeNovelUpdates } = require("./scrapers/novelupdates");
const { scrapeNovel: scrapeScribble } = require("./scrapers/scribble");
const { scrapeNovel: scrapeFanfiction } = require("./scrapers/fanfiction");
const { scrapeNovel: scrapeWuxiaworld } = require("./scrapers/wuxiaworld");
const { scrapeNovel: scrapeAO3 } = require("./scrapers/archiveofourown");
const { scrapeNovel: scrapeBoxnovel } = require("./scrapers/boxnovel");
const { scrapeNovel: scrapeReadlightnovel } = require("./scrapers/readlightnovel");
const { scrapeNovel: scrapeNovelfull } = require("./scrapers/novelfull");
const { scrapeNovel: scrapeMtlnovel } = require("./scrapers/mtlnovel");
const { scrapeNovel: scrapeGeneric } = require("./scrapers/generic");

const { createEpub } = require("./epub/builder");

// ---- SAFE ENV READ ----
const BOT_TOKEN = process.env.BOT_TOKEN;

console.log("BOT_TOKEN present:", !!BOT_TOKEN);

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN is NOT set. Waiting for Railway env injection...");
  setInterval(() => {
    console.error("⏳ BOT_TOKEN still missing...");
  }, 30000);
  process.exit(1);
}

// ---- INIT BOT ----
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ---- SESSION STORAGE FOR URLS & STATES ----
const sessionURLs = new Map();
const waitingForRange = new Map();
let sessionCounter = 0;

function generateSessionId() {
  return `s_${++sessionCounter}`;
}

function storeNovelURL(url) {
  const sessionId = generateSessionId();
  sessionURLs.set(sessionId, url);
  setTimeout(() => sessionURLs.delete(sessionId), 3600000); // Auto-delete after 1 hour
  return sessionId;
}

function getNovelURL(sessionId) {
  return sessionURLs.get(sessionId);
}

function setWaitingForRange(chatId, sessionId, msgId) {
  waitingForRange.set(chatId, { sessionId, msgId });
  setTimeout(() => waitingForRange.delete(chatId), 600000); // Auto-delete after 10 min
}

function getWaitingForRange(chatId) {
  return waitingForRange.get(chatId);
}

function clearWaitingForRange(chatId) {
  waitingForRange.delete(chatId);
}

// ---- SITE DETECTION ----
function detectSite(url) {
  const domain = new URL(url).hostname.toLowerCase();

  if (domain.includes("freewebnovel")) return { name: "FreeWebNovel", scraper: scrapeFreewebnovel };
  if (domain.includes("readlightnovel")) return { name: "ReadLightNovel", scraper: scrapeReadlightnovel };
  if (domain.includes("archiveofourown")) return { name: "Archive of Our Own", scraper: scrapeAO3 };
  if (domain.includes("fanfiction.net")) return { name: "FanFiction.net", scraper: scrapeFanfiction };
  if (domain.includes("scribblehub")) return { name: "ScribbleHub", scraper: scrapeScribble };
  if (domain.includes("novelupdates")) return { name: "Novel Updates", scraper: scrapeNovelUpdates };
  if (domain.includes("wuxiaworld")) return { name: "Wuxiaworld", scraper: scrapeWuxiaworld };
  if (domain.includes("boxnovel")) return { name: "BoxNovel", scraper: scrapeBoxnovel };
  if (domain.includes("novelfull")) return { name: "NovelFull", scraper: scrapeNovelfull };
  if (domain.includes("mtlnovel")) return { name: "MTLNovel", scraper: scrapeMtlnovel };
  if (domain.includes("royalroad")) return { name: "Royal Road", scraper: scrapeRoyalroad };
  if (domain.includes("wattpad")) return { name: "Wattpad", scraper: scrapeWattpad };
  if (domain.includes("webnovel")) return { name: "WebNovel", scraper: scrapeWebnovel };

  return { name: "Generic", scraper: scrapeGeneric };
}

// ---- FETCH NOVEL INFO ----
async function fetchNovelInfo(url) {
  try {
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    };

    const { data } = await axios.get(url, {
      headers,
      timeout: 10000,
      validateStatus: () => true
    });

    const $ = cheerio.load(data);

    let title = $("h1").first().text().trim() || $("title").text().trim() || "Novel";

    // Description extraction from multiple selectors
    let description = "";
    const descSelectors = [
      ".novel-intro",
      ".description",
      "[class*='desc']",
      ".synopsis",
      ".summary",
      ".novel-summary",
      "#summary",
      ".entry-content p"
    ];

    for (const sel of descSelectors) {
      const text = $(sel).text().trim();
      if (text && text.length > 30 && text.toLowerCase().indexOf(title.toLowerCase()) === -1) {
        description = text.replace(/\s+/g, " ").substring(0, 500);
        break;
      }
    }
    if (!description) description = "No description available";

    // Extract rating example (may need adjustment depending on site)
    let rating = "";
    const ratingElem = $(".rating-value, .score, .rating");
    if (ratingElem && ratingElem.length) {
      rating = ratingElem.first().text().trim();
    }

    return { title, description, rating };
  } catch (err) {
    console.error("fetchNovelInfo error:", err.message);
    return { title: "Novel", description: "Unable to fetch description", rating: "" };
  }
}

// Helper createProgressBar & formatTime - unchanged, keep your existing

// ... [Your existing createProgressBar and formatTime functions here] ...

// ---- PROCESS NOVEL (unchanged) ----
// ... Your existing processNovel function remains unchanged ...

// ---- COMMANDS ----
// ... Your existing /start command handler unchanged ...

// ---- URL DETECTION IN MESSAGES ----
bot.on("message", async msg => {
  if (!msg.text) return;

  // Check if message contains a URL
  const urlMatch = msg.text.match(/https?:\/\/[^\s]+/);

  if (urlMatch) {
    const novelUrl = urlMatch[0];
    const chatId = msg.chat.id;

    // Validate URL
    try {
      new URL(novelUrl);
    } catch (e) {
      await bot.sendMessage(chatId, "❌ Invalid URL. Please send a valid website link.");
      return;
    }

    const { name: siteName } = detectSite(novelUrl);

    // Fetch novel info
    const loadingMsg = await bot.sendMessage(chatId, `⏳ Fetching *${siteName}* info...`, { parse_mode: "Markdown" });

    const { title, description, rating } = await fetchNovelInfo(novelUrl);

    // Store URL in session and get short ID
    const sessionId = storeNovelURL(novelUrl);

    // Create chapter selection buttons
    const keyboard = {
      inline_keyboard: [
        [
          { text: "✏️ Custom Range", callback_data: `cr_${sessionId}` },
          { text: "📖 All Chapters", callback_data: `sc_999_${sessionId}` }
        ]
      ]
    };

    // Build message text cleanly
    let messageText = `📚 *${title}*\n\n`;
    if (description.length > 0) {
      messageText += `${description}\n\n`;
    }
    if (rating.length > 0) {
      messageText += `🌟 _Rating:_ ${rating}\n\n`;
    }
    messageText += `_Select option or enter custom chapter count:_`;

    try {
      await bot.deleteMessage(chatId, loadingMsg.message_id);

      await bot.sendMessage(chatId, messageText, {
        parse_mode: "Markdown",
        reply_markup: keyboard
      });
    } catch (err) {
      console.error("Error sending novel info:", err.message);
      await bot.sendMessage(chatId, messageText, {
        parse_mode: "Markdown",
        reply_markup: keyboard
      });
    }
  } else if (msg.text && !msg.text.startsWith("/")) {
    const chatId = msg.chat.id;

    const waiting = getWaitingForRange(chatId);
    if (waiting) {
      const chapterCount = parseInt(msg.text);
      if (!isNaN(chapterCount) && chapterCount > 0) {
        clearWaitingForRange(chatId);
        const novelUrl = getNovelURL(waiting.sessionId);

        if (novelUrl) {
          const limit = Math.min(chapterCount, 200);
          const processingMsg = await bot.sendMessage(chatId, "⏳ Starting scrape...", { parse_mode: "Markdown" });
          await processNovel(chatId, novelUrl, limit, processingMsg);
        } else {
          await bot.sendMessage(chatId, "❌ Session expired. Please send the novel URL again.");
        }

      } else {
        await bot.sendMessage(chatId, "❌ Please enter a valid number of chapters (e.g., 50)");
      }
    } else {
      await bot.sendMessage(chatId, "💬 Send a novel link and I'll help you convert it to EPUB!\n\nExample: https://royalroad.com/fiction/12345");
    }
  }
});

// ---- CALLBACK QUERY HANDLER (button clicks) ----
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (data.startsWith("cr_")) {
    const sessionId = data.substring(3);
    setWaitingForRange(chatId, sessionId, query.message.message_id);
    await bot.answerCallbackQuery(query.id, "📝 Send the number of chapters", false);
    await bot.sendMessage(chatId, "📝 How many chapters do you want? (1-200)\n\nExample: 50");
  } else if (data.startsWith("sc_")) {
    const parts = data.split("_");
    const chapterLimit = parseInt(parts[1]);
    const sessionId = parts.slice(2).join("_");

    const novelUrl = getNovelURL(sessionId);

    if (!novelUrl) {
      await bot.answerCallbackQuery(query.id, "❌ Session expired. Please send the URL again.", true);
      return;
    }

    await bot.answerCallbackQuery(query.id, "⏳ Starting to scrape...", false);

    const processingMsg = query.message;
    await processNovel(chatId, novelUrl, chapterLimit, processingMsg);
  }
});

console.log("✅ Bot initialized and polling started");
