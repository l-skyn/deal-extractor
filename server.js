// DEAL EXTRACTOR — SERVER
const express = require("express");
const fetch   = require("node-fetch");
const path    = require("path");
const config  = require("./config");

const app  = express();
const PORT = process.env.PORT || 3001;

const KEEPA_API  = "https://api.keepa.com";
const AMAZON_IMG = "https://images-na.ssl-images-amazon.com/images/I/";
const LINKTWIN   = "https://api.linktw.in/v1";

app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ── Parse raw text into deals ─────────────────
function parseDeals(raw) {
  // Detect format
  const isUKBargains = raw.includes("UK Bargains Finder") || raw.includes("amzlink.to") || raw.includes("Ad 👉");
  const isOwnFormat  = raw.trimStart().startsWith('"') && raw.includes('linktw.in') && !raw.includes("UK Bargains Finder") && !raw.includes("Author");

  let blocks;
  if (isOwnFormat) {
    // Split on closing/opening quote boundary
    blocks = raw.split(/(?<=\n)"(?="[\s\S])/g)
      .map(b => b.trim())
      .map(b => b.replace(/^"+/, '').replace(/"+$/, '').trim())
      .filter(b => b.includes('http') && b.includes('linktw.in'));
    // Fallback: split on double-quote delimiters
    if (!blocks.length) {
      blocks = raw.match(/"([\s\S]+?)"/g)
        ?.map(b => b.replace(/^"+/, '').replace(/"+$/, '').trim())
        .filter(b => b.includes('linktw.in')) || [];
    }
  } else if (isUKBargains) {
    blocks = raw.split(/(?=UK Bargains Finder)/g)
      .map(b => b.trim())
      .filter(b => b.startsWith("UK Bargains Finder") && b.includes("http"));
  } else {
    blocks = raw.split(/(?=Author\s*\n)/g)
      .map(b => b.trim())
      .filter(b => b.startsWith("Author") && b.includes("http"));
  }

  return blocks.map((block, idx) => {
    const lines = block.split("\n").map(l => l.trim()).filter(Boolean);

    // Find link
    const linkLine = lines.find(l => l.includes("http"));
    const link = linkLine ? linkLine.replace(/^Ad\s*👉🏼?\s*/i, '').trim() : null;

    // For own format: link is already our linktw.in — flag it
    const isOwnLink = link && link.includes('linktw.in') && isOwnFormat;

    // Description
    let descStart = 1;
    if (isOwnFormat) {
      // First non-empty line is description (skip badges/emojis-only lines)
      descStart = 0;
    } else if (isUKBargains) {
      descStart = lines.findIndex((l, i) => i > 0 && l !== '·' && !l.match(/^·\s*$/) && l.length > 10 && !l.includes('http'));
    } else {
      descStart = 2;
    }
    const descEnd = lines.findIndex((l, i) => i >= descStart && (/\d+%\s*OFF/i.test(l) || /price\s*drop/i.test(l) || /📉/i.test(l) || l.includes('http') || l.includes('Link to product') || /🏆|⏰|🥇/i.test(l)));
    const description = descStart < descEnd && descEnd > 0
      ? lines.slice(descStart, descEnd).join(" ").trim()
      : null;

    // All discount lines (exclude the description and link areas)
    const allDiscountLines = lines.filter(l =>
      (/\d+%/i.test(l) || /price\s*drop/i.test(l)) &&
      !l.includes('http') && !l.includes('AMAZON') && !l.includes('AMZLINK')
    );

    // Find main discount line (not "extra", not "prime", not "checkout", not "voucher only")
    const mainDiscountLine = allDiscountLines.find(l =>
      /\d+%\s*OFF/i.test(l) &&
      !/extra/i.test(l) &&
      !/prime/i.test(l) &&
      !/checkout/i.test(l) &&
      (!/voucher/i.test(l) || /reduction/i.test(l)) // "reduction" lines with voucher text are main discounts
    );
    const mainDiscountMatch = mainDiscountLine ? mainDiscountLine.match(/(\d+)%\s*OFF/i) : null;
    const mainDiscountHasVoucher = mainDiscountLine ? (/voucher/i.test(mainDiscountLine) && !/reduction/i.test(mainDiscountLine)) : false;
    const discount = mainDiscountMatch && !mainDiscountHasVoucher ? mainDiscountMatch[1] + "% OFF" : null;
    const discountWithVoucher = mainDiscountMatch && mainDiscountHasVoucher ? mainDiscountMatch[1] + "% OFF" : null;

    // Extra discount with voucher (e.g. "Extra 12% OFF with the voucher")
    const extraVoucherLine  = allDiscountLines.find(l => /extra/i.test(l) && /voucher/i.test(l));
    const extraVoucherMatch = extraVoucherLine ? extraVoucherLine.match(/(\d+)%/i) : null;
    const extraDiscountWithVoucher = extraVoucherMatch ? extraVoucherMatch[1] + "% OFF" : null;

    // Extra discount without voucher
    const extraLine  = allDiscountLines.find(l => /extra/i.test(l) && !/voucher/i.test(l));
    const extraMatch = extraLine ? extraLine.match(/(\d+)%/i) : null;
    const extraDiscount = extraMatch ? extraMatch[1] + "% OFF" : null;

    // Checkout discount
    const checkoutLine  = allDiscountLines.find(l => /checkout/i.test(l));
    const checkoutMatch = checkoutLine ? checkoutLine.match(/(\d+)%/i) : null;
    const checkoutDiscount = checkoutMatch ? checkoutMatch[1] + "% OFF" : null;

    // Prime Members discount
    const primeLine  = allDiscountLines.find(l => /prime/i.test(l));
    const primeMatch = primeLine ? primeLine.match(/(\d+)%/i) : null;
    const primeDiscount = primeMatch ? primeMatch[1] + "% OFF" : null;

    // Price drop
    const priceDropLine = lines.find(l => /price\s*drop/i.test(l) || /was\s*£/i.test(l) || /reduced\s*from/i.test(l));
    const isPriceDrop   = !!priceDropLine && !discount && !discountWithVoucher && !checkoutDiscount && !primeDiscount;

    // Product title — line after AMAZON.CO.UK or AMZLINK.TO
    const titleMarkerIdx = lines.findIndex(l => l.includes("AMAZON.CO.UK") || l.includes("AMAZON.COM") || l.includes("AMZLINK.TO"));
    const productTitle = titleMarkerIdx !== -1 && lines[titleMarkerIdx + 1] ? lines[titleMarkerIdx + 1] : null;

    return {
      id: idx + 1,
      originalLink: link,
      discount,
      discountWithVoucher,
      extraDiscount,
      extraDiscountWithVoucher,
      checkoutDiscount,
      primeDiscount,
      isPriceDrop: isPriceDrop || false,
      priceDropFrom: null,
      productTitle,
      description,
      isOwnLink: !!(link && link.includes('linktw.in') && isOwnFormat),
      asin: null,
      keepaTitle: null,
      generatedCaption: null,
      shortLink: null,
      status: "pending",
      error: null,
    };
  }).filter(d => d.originalLink);
}

// ── Follow short link to get Amazon URL + ASIN ─
async function resolveASIN(shortUrl) {
  try {
    const res = await fetch(shortUrl, {
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" }
    });
    const finalUrl = res.url;
    const match = finalUrl.match(/\/dp\/([A-Z0-9]{10})|\/gp\/product\/([A-Z0-9]{10})/);
    if (match) return { asin: match[1] || match[2], url: finalUrl };
    return { asin: null, url: finalUrl };
  } catch(e) {
    return { asin: null, url: shortUrl, error: e.message };
  }
}


// ── Category + Commission lookup ─────────────
const KEEPA_CATEGORIES = {
  // UK Keepa root category IDs → name + commission
  // Rates from official Amazon UK Associates programme (affiliate-program.amazon.co.uk)
  11961407031: { name: "Fashion", rate: 6 },         // Clothing & Accessories
  117332031:   { name: "Beauty", rate: 4 },           // Beauty
  468292:      { name: "Toys & Games", rate: 3 },     // All Other
  340840031:   { name: "Pet Supplies", rate: 3 },     // All Other
  192413031:   { name: "Stationery & Office", rate: 3 }, // All Other
  318949011:   { name: "Sports & Fitness", rate: 4 }, // Sports & Fitness
  283926:      { name: "DVD & Blu-ray", rate: 3 },    // All Other
  59624031:    { name: "Baby Products", rate: 3 },    // All Other
  560798:      { name: "Electronics & Photo", rate: 3 }, // All Other
  11052671:    { name: "Garden", rate: 3 },           // All Other
  3146281:     { name: "Home & Garden", rate: 5 },    // Home
  11052681:    { name: "Home & Kitchen", rate: 5 },   // Kitchen & Dining
  340831031:   { name: "Computers & Accessories", rate: 3 }, // All Other
  5866054031:  { name: "Business & Industry", rate: 3 }, // All Other
  65801031:    { name: "Health & Personal Care", rate: 4 }, // Personal Care Appliances
  248877031:   { name: "Automotive", rate: 5 },       // Automotive
  79903031:    { name: "DIY & Tools", rate: 5 },      // Power & Hand Tools
  340837031:   { name: "Musical Instruments", rate: 3 }, // All Other
  341677031:   { name: "Kindle Store", rate: 5 },     // Kindle Books
  266239:      { name: "Books", rate: 5 },            // Books
  229816:      { name: "CDs & Vinyl", rate: 5 },      // Music
  340834031:   { name: "Grocery", rate: 1 },          // Grocery
  300703:      { name: "PC & Video Games", rate: 1 }, // Video Games
  213077031:   { name: "Lighting", rate: 5 },         // Home Improvement
  11052671:    { name: "Garden", rate: 5 },           // Home Improvement
  1661657031:  { name: "Apps & Games", rate: 0 },     // Android Apps
};


const CATEGORY_RATES_BY_NAME = {
  "Fashion":                      6,
  "Beauty":                       4,
  "Toys & Games":                 3,
  "Pet Supplies":                 3,
  "Stationery & Office Supplies": 3,
  "Sports & Outdoors":            4,
  "Sports & Fitness":             4,
  "DVD & Blu-ray":                3,
  "Baby Products":                3,
  "Lighting":                     5,
  "Electronics & Photo":          3,
  "Garden":                       5,
  "Home & Garden":                5,
  "PC & Video Games":             1,
  "Home & Kitchen":               5,
  "Computers & Accessories":      3,
  "Business, Industry & Science": 3,
  "Health & Personal Care":       4,
  "Automotive":                   5,
  "DIY & Tools":                  5,
  "Kindle Store":                 5,
  "Books":                        5,
  "CDs & Vinyl":                  5,
  "Music":                        5,
  "Audible Books & Originals":    3,
  "Grocery":                      1,
  "Home":                         5,
  "Kitchen & Dining":             5,
  "Furniture":                    5,
  "Home Improvement":             5,
  "Power & Hand Tools":           5,
  "Jewellery":                    5,
  "Luggage":                      4,
  "Shoes":                        6,
  "Watches":                      6,
  "Clothing & Accessories":       6,
};

function getCategoryInfo(rootCategoryId) {
  if (!rootCategoryId) return { name: "Other", rate: 4 };
  const cat = KEEPA_CATEGORIES[String(rootCategoryId)];
  return cat || { name: "Other", rate: 4 };
}

function getCategoryRate(categoryName) {
  if (!categoryName) return 4;
  return CATEGORY_RATES_BY_NAME[categoryName] ?? 3;
}
// ── Keepa product lookup ──────────────────────
async function keepaLookup(asin, domain) {
  try {
    const res  = await fetch(`${KEEPA_API}/product?key=${config.keepaApiKey}&domain=${domain||2}&asin=${asin}&history=0&stats=90`);
    const data = await res.json();
    if (data.products && data.products.length > 0) {
      const p = data.products[0];

      // New images[] format: each obj has 'l' (large 1600px) and 'm' (medium 500px)
      let images = [];
      if (p.images && p.images.length) {
        images = p.images.map(img => {
          const filename = img.l || img.m || null;
          return filename ? `${AMAZON_IMG}${filename}` : null;
        }).filter(Boolean);
      }

      // Rating from csv[16] (RATING time series): [time, value, time, value, ...]
      // Values are rating * 10 (e.g. 45 = 4.5 stars), odd indices are values
      let rating = null;
      if (p.csv && p.csv[16] && p.csv[16].length >= 2) {
        // Walk backwards through odd indices to find last valid rating
        for (let i = p.csv[16].length - 1; i >= 1; i -= 2) {
          if (p.csv[16][i] > 0) {
            rating = (p.csv[16][i] / 10).toFixed(1);
            break;
          }
        }
      }

      const catInfo = getCategoryInfo(p.rootCategory);
      const commissionRate = getCategoryRate(catInfo.name);
      console.log("rootCategory:", p.rootCategory, "→", catInfo.name, commissionRate + "% | rating:", rating, "| images:", images.length);
      console.log("RAW images field:", JSON.stringify(p.images ? p.images.slice(0,2) : null));
      console.log("RAW imagesCSV:", p.imagesCSV ? p.imagesCSV.slice(0,100) : null);
      console.log("RAW stats.current:", JSON.stringify(p.stats ? p.stats.current : null));
      return { title: p.title, images, category: catInfo.name, commissionRate, rating };
    }
    return { title: null, images: [], category: "Other", commissionRate: 4, rating: null };
  } catch(e) {
    return { title: null, images: [], error: e.message, rating: null };
  }
}

// ── Generate caption with Claude ──────────────
async function generateCaption(title, discount, extraDiscount) {
  const discountText = extraDiscount
    ? `${discount} + Extra ${extraDiscount}`
    : discount;

  const prompt = `You write short, punchy, funny Facebook deal post captions for a UK deals page called "Sir Deals".

Style: British humor, conversational, emoji-heavy, witty one-liner or short joke to open, then 1-2 lines max about the product. Keep it SHORT — no long descriptions. Do NOT include the discount percentage in the caption — that will be added separately.

Product: ${title}

Write ONE caption. No hashtags. No links. No discount info. Just the caption text.`;

  try {
    const res  = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.anthropicApiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }]
      })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.content[0].text.trim();
  } catch(e) {
    console.log("Caption generation error:", e.message);
    return null;
  }
}

// ── Create linktw.in short link ───────────────
async function createShortLink(amazonUrl) {
  try {
    // Add associate tag to Amazon URL
    const url = new URL(amazonUrl);
    url.searchParams.set("tag", config.amazonTag);
    const taggedUrl = url.toString();

    const res  = await fetch("https://linktw.in/api/url/add", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.linkTwinApiKey}`
      },
      body: JSON.stringify({ url: taggedUrl })
    });
    const data = await res.json();
    console.log("LinkTwin response:", JSON.stringify(data));
    // Response format: { error: 0, shorturl: "https://linktw.in/xxx" }
    return data?.shorturl || data?.data?.shorturl || data?.data?.short_url || null;
  } catch(e) {
    console.log("LinkTwin error:", e.message);
    return null;
  }
}

// ── Routes ────────────────────────────────────

// Parse raw text
app.post("/api/parse", (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "No text provided" });
  const deals = parseDeals(text);
  res.json({ deals, count: deals.length });
});

// Enrich a single deal (called per deal from frontend)
app.post("/api/enrich", async (req, res) => {
  const { deal } = req.body;
  if (!deal) return res.status(400).json({ error: "No deal provided" });

  const result = { ...deal, status: "processing" };

  // Step 1: Resolve ASIN
  const { asin, url: amazonUrl, error: resolveErr } = await resolveASIN(deal.originalLink);
  if (!asin) {
    return res.json({ ...result, status: "error", error: resolveErr || "Could not find ASIN from link" });
  }
  result.asin = asin;
  result.amazonUrl = amazonUrl;

  // Detect domain
  let domain = 2; // UK default
  if (amazonUrl.includes("amazon.com")) domain = 1;
  else if (amazonUrl.includes("amazon.de")) domain = 3;
  else if (amazonUrl.includes("amazon.fr")) domain = 4;

  // Step 2: Keepa
  const { title, images, category, commissionRate, rating } = await keepaLookup(asin, domain);
  result.keepaTitle = title;
  result.images = images;
  result.category = category || "Other";
  result.commissionRate = commissionRate || 4;
  result.rating = rating || null;

  // Step 3: Generate caption
  const caption = await generateCaption(title || deal.productTitle, deal.discount, deal.extraDiscount);
  result.generatedCaption = caption;

  // Step 4: Create short link (skip if already our own linktw.in link)
  let shortLink = null;
  if (deal.isOwnLink) {
    shortLink = deal.originalLink; // keep existing link
  } else {
    shortLink = await createShortLink(amazonUrl);
  }
  result.shortLink = shortLink;

  result.status = "done";
  console.log("Returning shortLink:", result.shortLink);
  res.json(result);
});

// Send to FB Scheduler
// old send-to-scheduler removed

function formatForPaste(deals) {
  return deals.map(d => {
    const lines = [
      d.generatedCaption || d.productTitle || "",
      d.discount ? `🔻 REDUCED PRICE (${d.discount})` : "",
      d.extraDiscount ? `➕ Extra ${d.extraDiscount} available!` : "",
      d.shortLink || d.originalLink,
    ].filter(Boolean);
    return `"${lines.join("\n")}\n＿＿＿＿＿＿＿＿\n🎁 You have a chance to win AWESOME prizes in our giveaway! Curious? Ask me how!"`;
  }).join("\n");
}

app.listen(PORT, () => console.log(`\n  Deal Extractor at http://localhost:${PORT}\n`));

// ── Keepa Deals Browser ───────────────────────
app.post("/api/keepa-deals", async (req, res) => {
  const { categories, minDiscount, maxPrice, limit, page } = req.body;

  const selection = {
    domainId: 2, // UK
    page: page || 0,
    priceTypes: [0], // 0 = Amazon price (must be array with one entry)
    isFilterEnabled: true,
    isRangeEnabled: true,
  };

  if (minDiscount) selection.deltaPercentRange = [minDiscount, 100];
  if (maxPrice) selection.currentRange = [0, maxPrice * 100]; // Keepa uses cents
  if (categories && categories.length) selection.includeCategories = categories;
  if (req.body.minRating) selection.minRating = Math.round(req.body.minRating * 10); // Keepa uses 0-50 scale

  try {
    const selectionStr = encodeURIComponent(JSON.stringify(selection));
    const res2 = await fetch(`${KEEPA_API}/deal?key=${config.keepaApiKey}&selection=${selectionStr}`, {
      method: "GET",
    });
    const data = await res2.json();

    
    const dr = data.deals ? data.deals.dr : data.dr;
    if (!dr || !dr.length) return res.json({ deals: [], error: typeof data.error === 'object' ? JSON.stringify(data.error) : (data.error || "No deals returned - try different filters") });

    // Build category name→rate map from the response's category list
    const responseCatMap = {};
    if (data.deals.categoryIds) {
      data.deals.categoryIds.forEach((id, i) => {
        const name = data.deals.categoryNames[i];
        if (name && name !== "?") {
          responseCatMap[String(id)] = { name, rate: getCategoryRate(name) };
        }
      });
    }

    // Find the best rate from selected categories
    const selectedRate = categories && categories.length
      ? Math.max(...categories.map(id => responseCatMap[String(id)]?.rate || getCategoryRate(responseCatMap[String(id)]?.name) || 4))
      : 4;
    const selectedCategoryName = categories && categories.length && responseCatMap[String(categories[0])]
      ? responseCatMap[String(categories[0])].name
      : "Other";

    // Limit results
    const maxDeals = Math.min(limit || 50, 150);
    const deals = dr.slice(0, maxDeals).map(d => {
      try {
        // avg[0] = Amazon price array, first positive value = current price
        const priceArr   = Array.isArray(d.avg) && Array.isArray(d.avg[0]) ? d.avg[0] : [];
        const currentRaw = priceArr.find(v => typeof v === 'number' && v > 0) || null;
        const avgRaw     = priceArr[0] > 0 ? priceArr[0] : null;
        const currentPrice = currentRaw ? (currentRaw / 100).toFixed(2) : null;
        const avgPrice     = avgRaw ? (avgRaw / 100).toFixed(2) : null;

        // discount: calculate from avg vs current if deltaPercent not available
        let discount = null;
        if (Array.isArray(d.deltaPercent) && Array.isArray(d.deltaPercent[0])) {
          const dp = d.deltaPercent[0].find(v => typeof v === 'number' && v > 0 && v <= 100);
          if (dp) discount = Math.round(dp);
        }
        if (!discount && avgRaw && currentRaw && currentRaw < avgRaw) {
          discount = Math.round((1 - currentRaw / avgRaw) * 100);
        }

        const images  = d.imagesCSV ? d.imagesCSV.split(',').filter(Boolean).map(img => `${AMAZON_IMG}${img}`) : [];

        return {
          id: d.asin,
          asin: d.asin,
          parentAsin: d.parentAsin || null,
          title: d.title || null,
          currentPrice,
          avgPrice,
          discount,
          category: selectedCategoryName,
          commissionRate: selectedRate,
          images,
          amazonUrl: `https://www.amazon.co.uk/dp/${d.asin}`,
          generatedCaption: null,
          shortLink: null,
          status: "pending",
          error: null,
          selected: false,
          isOwnLink: false,
          originalLink: `https://www.amazon.co.uk/dp/${d.asin}`,
        };
      } catch(e) {
        return {
          id: d.asin, asin: d.asin, title: null, currentPrice: null,
          avgPrice: null, discount: null, category: "Other", commissionRate: 4,
          images: [], amazonUrl: `https://www.amazon.co.uk/dp/${d.asin}`,
          generatedCaption: null, shortLink: null, status: "pending",
          error: null, selected: false, isOwnLink: false,
          originalLink: `https://www.amazon.co.uk/dp/${d.asin}`,
        };
      }
    });

    // Deduplicate by parentAsin if requested
    let finalDeals = deals;
    if (req.body.dedupeVariants) {
      const seen = new Map();
      for (const deal of deals) {
        const key = deal.parentAsin || deal.asin;
        if (!seen.has(key)) {
          seen.set(key, deal);
        } else {
          // Keep the one with better discount
          const existing = seen.get(key);
          if ((deal.discount || 0) > (existing.discount || 0)) {
            seen.set(key, deal);
          }
        }
      }
      finalDeals = Array.from(seen.values());
    }

    res.json({ deals: finalDeals, total: dr.length, deduped: deals.length - finalDeals.length });
  } catch(e) {
    console.log("Keepa deals error:", e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});

// ── Keepa Categories ──────────────────────────
app.get("/api/keepa-categories", async (req, res) => {
  try {
    // Fetch a small deal request just to get the category list
    // Must include priceTypes + isFilterEnabled + isRangeEnabled + deltaPercentRange to be valid
    const selection = { domainId: 2, page: 0, priceTypes: [0], isFilterEnabled: true, isRangeEnabled: true, deltaPercentRange: [20, 100] };
    const selectionStr = encodeURIComponent(JSON.stringify(selection));
    const r = await fetch(`${KEEPA_API}/deal?key=${config.keepaApiKey}&selection=${selectionStr}`);
    const data = await r.json();

    console.log("Categories response:", JSON.stringify(data).slice(0, 200));

    if (!data.deals || !data.deals.categoryIds) {
      return res.json({ categories: [], debug: data.error || "no deals object" });
    }

    // Zip categoryIds + categoryNames + categoryCount together
    const categories = data.deals.categoryIds.map((id, i) => ({
      id: String(id),
      name: data.deals.categoryNames[i] || "Unknown",
      count: data.deals.categoryCount[i] || 0,
    }))
    .filter(c => c.name !== "?" && c.count > 0)
    .sort((a, b) => a.name.localeCompare(b.name));

    res.json({ categories });
  } catch(e) {
    res.status(500).json({ error: e.message, categories: [] });
  }
});

// ── Proxy to FB Scheduler ─────────────────────
app.post("/api/send-to-scheduler", async (req, res) => {
  const { comments, schedulerUrl, caption, firstComment, lastComment, timezone } = req.body;
  console.log("send-to-scheduler comments[0]:", JSON.stringify(comments && comments[0]));
  if (!comments || !comments.length) return res.status(400).json({ error: "No comments provided - body: " + JSON.stringify(req.body).slice(0, 100) });
  const target = schedulerUrl || config.schedulerUrl;

  try {
    const r = await fetch(`${target}/api/staging`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deals: comments })
    });
    const data = await r.json();
    if (data.success) {
      res.json({ success: true, message: `${comments.length} deals added to Extractor Queue!` });
    } else {
      res.json({ success: false, error: data.error || "Scheduler rejected the request" });
    }
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});
