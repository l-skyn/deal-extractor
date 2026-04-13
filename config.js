module.exports = {
  keepaApiKey:     process.env.KEEPA_API_KEY     || "",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  linkTwinApiKey:  process.env.LINKTWIN_API_KEY  || "",
  amazonTag:       process.env.AMAZON_TAG        || "sirdealsalot-21",
  schedulerUrl:    process.env.SCHEDULER_URL     || "http://localhost:3000",
};
