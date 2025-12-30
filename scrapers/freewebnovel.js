const axios = require("axios");
const cheerio = require("cheerio");

const headers = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Referer": "https://freewebnovel.com/",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "f, deflate, br",
  "DNT": "1",
  "Connection": "keep-alive",
  "Upgrade-Insecure-Requests": "1"
};

const delay = ms => new Promise(r => setTimeout(r, ms));

async function scrapeChapterWithRetry(url, maxRetries = 3) {
  let lastError = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const chapter = await scrapeChapter(url);
      
      // Check if we got meaningful content
      if (chapter.content && chapter.content.length > 150 && 
          !chapter.content.includes("[Content unavailable")) {
        return chapter;
      }
      
      // If content is too short, it likely failed - retry
      if (attempt < maxRetries) {
        const waitTime = Math.random() * 2000 + (attempt * 1000); // Exponential backoff
        await delay(waitTime);
        continue;
      }
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const waitTime = Math.random() * 2000 + (attempt * 1000);
        await delay(waitTime);
        continue;
      }
    }
  }
  
  // Return fallback after all retries exhausted
  return { title: "Chapter", content: "<p>[Content unavailable after retries]</p>" };
}

async function scrapeChapter(url) {
  try {
    const { data } = await axios.get(url, { 
      headers,
      timeout: 15000,
      maxRedirects: 5,
      validateStatus: () => true
    });
    const $ = cheerio.load(data);

    const title = $(".chapter-title").text().trim() || 
                  $("h1.chapter-title").text().trim() ||
                  $("h1").first().text().trim() ||
                  "Chapter";

    let content = "";
    
    // Try multiple selector patterns for content
    const contentSelectors = [
      "#chapter-content",
      ".chapter-content",
      ".chapter-body",
      ".chr-c",
      ".cha-words",
      "[class*='chapter'][class*='content']",
      ".content",
      "div.text",
      ".text-content",
      "article"
    ];

    for (const selector of contentSelectors) {
      const extracted = $(selector).html();
      if (extracted && extracted.length > 100) {
        content = extracted;
        break;
      }
    }

    // Fallback: extract all paragraphs if no content found
    if (!content || content.length < 50) {
      const paragraphs = [];
      $("p").each((_, el) => {
        const text = $(el).text().trim();
        if (text && text.length > 20) {
          paragraphs.push(`<p>${text}</p>`);
        }
      });
      if (paragraphs.length > 0) {
        content = paragraphs.join("");
      }
    }

    // Clean up content
    content = content.replace(/<script[^>]*>.*?<\/script>/gi, "")
                    .replace(/<style[^>]*>.*?<\/style>/gi, "")
                    .replace(/<nav[^>]*>.*?<\/nav>/gi, "")
                    .replace(/<footer[^>]*>.*?<\/footer>/gi, "")
                    .replace(/<header[^>]*>.*?<\/header>/gi, "")
                    .replace(/<button[^>]*>.*?<\/button>/gi, "");

    // Remove common navigation text
    content = content.replace(/Use arrow keys \(or A \/ D\) to PREV\/NEXT chapter/gi, "")
                    .replace(/Use arrow keys.*?chapter/gi, "")
                    .replace(/←.*?→/g, "")
                    .replace(/Previous Chapter.*?Next Chapter/gi, "");

    // Clean up extra whitespace from removed content
    content = content.replace(/<p>\s*<\/p>/g, "").replace(/\n{3,}/g, "\n\n");

    if (!content || content.length < 50) {
      content = "<p>[Chapter content not available - content extraction failed]</p>";
    }

    return { title: title || "Chapter", content };
  } catch (err) {
    console.error(`Error scraping chapter:`, err.message);
    return { title: "Chapter", content: "<p>[Content unavailable - request failed]</p>" };
  }
}

async function scrapeNovel(novelUrl, limit = 25, onProgress = null) {
  try {
    const { data } = await axios.get(novelUrl, { 
      headers,
      timeout: 15000,
      validateStatus: () => true
    });
    const $ = cheerio.load(data);

    const novelTitle = $("h1.novel-title").text().trim() ||
                       $("h1").first().text().trim() || 
                       "Unknown Novel";

    let chapterLinks = [];
    
    // Strategy 1: Look for chapter links in common patterns
    $("a").each((_, el) => {
      const href = $(el).attr("href");
      const text = $(el).text().toLowerCase();
      
      if (href && (href.includes("chapter") || text.includes("chapter"))) {
        try {
          const url = href.startsWith("http") ? href : new URL(href, novelUrl).href;
          // Verify it's from same domain
          if (new URL(url).hostname === new URL(novelUrl).hostname) {
            if (!chapterLinks.includes(url)) {
              chapterLinks.push(url);
            }
          }
        } catch (e) {}
      }
    });

    chapterLinks = [...new Set(chapterLinks)];
    const chaptersToScrape = chapterLinks.slice(0, limit);
    
    console.log(`Found ${chapterLinks.length} chapters, scraping ${chaptersToScrape.length}`);
    if (onProgress) onProgress(0, chaptersToScrape.length);

    if (chaptersToScrape.length === 0) {
      throw new Error("No chapters found");
    }

    const chapters = [];
    for (let i = 0; i < chaptersToScrape.length; i++) {
      chapters.push(await scrapeChapterWithRetry(chaptersToScrape[i], 3));
      if (onProgress) onProgress(i + 1, chaptersToScrape.length);
      await delay(Math.random() * 2000 + 1000);
    }

    return { novelTitle, chapters };
  } catch (err) {
    throw new Error(`Failed to scrape FreeWebNovel: ${err.message}`);
  }
}

module.exports = { scrapeNovel };
