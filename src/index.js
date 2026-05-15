require('dotenv').config();
const Groq = require('groq-sdk');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const express = require('express');
const cookieParser = require('cookie-parser');
const { shopifyApi, ApiVersion } = require('@shopify/shopify-api');
const { nodeAdapter } = require('@shopify/shopify-api/adapters/node');
const { createClient } = require('redis');

// Redis client
const redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
redis.on('error', err => console.error('Redis error:', err));
redis.connect().then(() => console.log('✅ Redis connected'));

const app = express();
app.use(express.json());
app.use(cookieParser(process.env.COOKIE_SECRET || 'shoppilot-secret-key'));
app.set('trust proxy', 1);

const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: process.env.SHOPIFY_SCOPES.split(','),
  hostName: process.env.HOST.replace('https://', ''),
  apiVersion: ApiVersion.July25,
  isEmbeddedApp: false,
  adapter: nodeAdapter,
  cookieOptions: {
    sameSite: 'none',
    secure: true,
  },
});

app.get('/auth', async (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).send('Missing shop parameter');
  await shopify.auth.begin({
    shop,
    callbackPath: '/auth/callback',
    isOnline: false,
    rawRequest: req,
    rawResponse: res,
  });
});

app.get('/auth/callback', async (req, res) => {
  try {
    const callback = await shopify.auth.callback({
      rawRequest: req,
      rawResponse: res,
    });
    const session = callback.session;
    console.log('✅ Store connected:', session.shop);

    // Save session to Redis — keyed by shop, lasts 30 days
    await redis.set(`session:${session.shop}`, JSON.stringify({
      shop: session.shop,
      accessToken: session.accessToken,
      scope: session.scope || ''
    }), { EX: 30 * 24 * 60 * 60 });

    // Store shop name in cookie so we know which Redis key to look up
    res.cookie('sp_shop', session.shop, { httpOnly: false, secure: true, sameSite: 'none', maxAge: 30 * 24 * 60 * 60 * 1000 });

    res.redirect('/?connected=true');
  } catch (error) {
    console.error('Auth error:', error);
    res.status(500).send('Authentication failed: ' + error.message);
  }
});

app.get('/shopify-report', async (req, res) => {
  const shop = req.cookies.sp_shop || req.query.shop;
  if (!shop) return res.status(400).json({ error: 'No shop connected. Please connect your Shopify store first.' });

  // Look up session from Redis
  const sessionData = await redis.get(`session:${shop}`);
  if (!sessionData) return res.status(401).json({ error: 'Session expired. Please reconnect your store.' });

  const { accessToken, scope } = JSON.parse(sessionData);

  const session = {
    shop,
    accessToken,
    scope: scope || '',
    isOnline: false,
    id: `offline_${shop}`,
    state: '',
    isActive: () => true,
  };

  try {
    const client = new shopify.clients.Rest({ session });

    // Orders require protected data approval — skip for now
    const totalOrders = 0;
    const totalRevenue = 0;
    const avgOrderValue = 0;
    const topProductName = 'N/A';

    // Get total products count (read_products is safe)
    const productsResponse = await client.get({ path: 'products/count' });
    const totalProducts = productsResponse.body.count || 0;

    const totalCustomers = 'N/A';

    const storeName = shop.replace('.myshopify.com', '');

    const systemPrompt = `You are ShopPilot, an expert ecommerce analyst AI. You produce weekly store performance reports.

CRITICAL RULES:
1. NEVER use placeholder text like [insert value], [X%], or any bracketed estimates.
2. NEVER use markdown symbols like **, *, ##, or ---.
3. Only reference numbers from the data provided. Do not invent metrics.
4. Be specific, concrete, and actionable.
5. Respond ONLY with a valid JSON object — no preamble, no markdown fences.

Return this exact JSON structure:
{
  "summary": "2-3 sentence executive summary using the real numbers",
  "highlights": ["highlight 1", "highlight 2", "highlight 3"],
  "insights": [
    { "title": "short title", "body": "2-3 sentence insight" },
    { "title": "short title", "body": "2-3 sentence insight" },
    { "title": "short title", "body": "2-3 sentence insight" }
  ],
  "recommendations": [
    { "title": "action title", "body": "specific recommendation" },
    { "title": "action title", "body": "specific recommendation" },
    { "title": "action title", "body": "specific recommendation" }
  ],
  "nextSteps": [
    "Concrete action item 1",
    "Concrete action item 2",
    "Concrete action item 3",
    "Concrete action item 4"
  ]
}`;

    const userPrompt = `Generate a weekly report for this Shopify store:
- Store: ${storeName}
- Orders this week: ${totalOrders}
- Revenue this week: $${totalRevenue.toFixed(2)}
- Average order value: $${avgOrderValue}
- Top selling product: ${topProductName}
- Total products in store: ${totalProducts}
- Total customers: ${totalCustomers}

Use only these exact numbers.`;

    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.4
    });

    const raw = response.choices[0].message.content;
    let reportData;
    try {
      reportData = JSON.parse(raw);
    } catch (e) {
      return res.status(500).json({ error: 'Failed to parse report', raw });
    }

    res.json({
      success: true,
      reportData,
      meta: {
        storeName,
        orders: totalOrders,
        revenue: totalRevenue.toFixed(2),
        avgOrderValue,
        topProduct: topProductName,
        totalProducts,
        totalCustomers
      }
    });

  } catch (err) {
    console.error('Shopify report error:', err.message);
    res.status(500).json({ error: 'Failed to fetch store data', details: err.message });
  }
});

// Check if a store is connected (used by frontend on page load)
app.get('/session-status', async (req, res) => {
  const shop = req.cookies.sp_shop;
  if (!shop) return res.json({ connected: false });
  const sessionData = await redis.get(`session:${shop}`);
  if (sessionData) {
    res.json({ connected: true, shop });
  } else {
    res.json({ connected: false });
  }
});

// Disconnect store — clear cookie and Redis
app.get('/disconnect', async (req, res) => {
  const shop = req.cookies.sp_shop;
  if (shop) await redis.del(`session:${shop}`);
  res.clearCookie('sp_shop');
  res.json({ success: true, message: 'Store disconnected' });
});

app.post('/chat', async (req, res) => {
  const { message, storeContext } = req.body;
  if (!message) return res.status(400).json({ error: 'Missing message' });
  const response = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: `You are a helpful customer support assistant for a Shopify store. ${storeContext || ''}` },
      { role: 'user', content: message }
    ]
  });
  res.json({ reply: response.choices[0].message.content });
});

app.post('/generate-description', async (req, res) => {
  const { productName, details } = req.body;
  if (!productName) return res.status(400).json({ error: 'Missing productName' });
  const response = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: 'You are an expert ecommerce copywriter. Write compelling, SEO-friendly product descriptions.' },
      { role: 'user', content: `Write a product description for: ${productName}. Details: ${details || 'none provided'}` }
    ]
  });
  res.json({ description: response.choices[0].message.content });
});

app.post('/generate-caption', async (req, res) => {
  const { productName, platform } = req.body;
  if (!productName) return res.status(400).json({ error: 'Missing productName' });
  const response = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: `You are a social media expert. Write engaging captions for ${platform || 'Instagram'}.` },
      { role: 'user', content: `Write a social media caption for this product: ${productName}` }
    ]
  });
  res.json({ caption: response.choices[0].message.content });
});

app.post('/weekly-report', async (req, res) => {
  const { storeName, totalOrders, totalRevenue, topProduct } = req.body;
  if (!storeName) return res.status(400).json({ error: 'Missing storeName' });

  const orders = parseInt(totalOrders) || 0;
  const revenue = parseFloat(totalRevenue) || 0;
  const avgOrderValue = orders > 0 ? (revenue / orders).toFixed(2) : 0;

  const systemPrompt = `You are ShopPilot, an expert ecommerce analyst AI.

CRITICAL RULES:
1. NEVER use placeholder text like [insert value], [X%], or bracketed estimates.
2. NEVER use markdown symbols like **, *, ##, or ---.
3. Only use numbers from the data provided.
4. Respond ONLY with a valid JSON object.

Return this exact JSON:
{
  "summary": "2-3 sentence summary",
  "highlights": ["highlight 1", "highlight 2", "highlight 3"],
  "insights": [
    { "title": "title", "body": "insight" },
    { "title": "title", "body": "insight" },
    { "title": "title", "body": "insight" }
  ],
  "recommendations": [
    { "title": "title", "body": "recommendation" },
    { "title": "title", "body": "recommendation" },
    { "title": "title", "body": "recommendation" }
  ],
  "nextSteps": ["step 1", "step 2", "step 3", "step 4"]
}`;

  try {
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Store: ${storeName}, Orders: ${orders}, Revenue: $${revenue}, Avg order: $${avgOrderValue}, Top product: ${topProduct || 'Not specified'}` }
      ],
      temperature: 0.4
    });

    const raw = response.choices[0].message.content;
    let reportData;
    try { reportData = JSON.parse(raw); }
    catch (e) { return res.status(500).json({ error: 'Failed to parse report', raw }); }

    res.json({ success: true, reportData, meta: { storeName, orders, revenue, avgOrderValue, topProduct } });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate report', details: err.message });
  }
});

app.use(express.static('src/public'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ShopPilot running on port ${PORT}`);
});
