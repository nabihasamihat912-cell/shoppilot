require('dotenv').config();
const Groq = require('groq-sdk');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const express = require('express');
const cookieParser = require('cookie-parser');
const { shopifyApi, ApiVersion } = require('@shopify/shopify-api');
const { nodeAdapter } = require('@shopify/shopify-api/adapters/node');

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

    // Persist session data in signed cookies — survives Render redeploys
    const cookieOpts = { httpOnly: true, secure: true, sameSite: 'none', maxAge: 30 * 24 * 60 * 60 * 1000 }; // 30 days
    res.cookie('sp_shop', session.shop, { ...cookieOpts, httpOnly: false }); // readable by JS for UI
    res.cookie('sp_token', session.accessToken, { ...cookieOpts, signed: true }); // signed, httpOnly
    res.cookie('sp_scope', session.scope || '', { ...cookieOpts, signed: true });

    res.redirect('/?connected=true');
  } catch (error) {
    console.error('Auth error:', error);
    res.status(500).send('Authentication failed: ' + error.message);
  }
});

app.get('/shopify-report', async (req, res) => {
  const shop = req.cookies.sp_shop || req.query.shop;
  if (!shop) return res.status(400).json({ error: 'No shop connected. Please connect your Shopify store first.' });

  // Reconstruct session from signed cookie — works across Render redeploys
  const accessToken = req.signedCookies.sp_token;
  if (!accessToken) return res.status(401).json({ error: 'Session expired. Please reconnect your store.' });

  // Build a minimal session object the Shopify client needs
  const session = {
    shop,
    accessToken,
    scope: req.signedCookies.sp_scope || '',
    isOnline: false,
    id: `offline_${shop}`,
    state: '',
    isActive: () => true,
  };

  try {
    const client = new shopify.clients.Rest({ session });

    // Get orders from last 7 days
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

    const ordersResponse = await client.get({
      path: 'orders',
      query: {
        status: 'any',
        created_at_min: oneWeekAgo.toISOString(),
        limit: 250,
        fields: 'id,total_price,line_items,created_at,financial_status'
      }
    });

    const orders = ordersResponse.body.orders || [];
    const totalOrders = orders.length;
    const totalRevenue = orders.reduce((sum, o) => sum + parseFloat(o.total_price || 0), 0);
    const avgOrderValue = totalOrders > 0 ? (totalRevenue / totalOrders).toFixed(2) : 0;

    // Find top selling product
    const productSales = {};
    orders.forEach(order => {
      (order.line_items || []).forEach(item => {
        productSales[item.title] = (productSales[item.title] || 0) + item.quantity;
      });
    });
    const topProduct = Object.entries(productSales).sort((a, b) => b[1] - a[1])[0];
    const topProductName = topProduct ? topProduct[0] : 'No products sold this week';

    // Get total products count
    const productsResponse = await client.get({ path: 'products/count' });
    const totalProducts = productsResponse.body.count || 0;

    // Get customers count
    const customersResponse = await client.get({ path: 'customers/count' });
    const totalCustomers = customersResponse.body.count || 0;

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
app.get('/session-status', (req, res) => {
  const shop = req.cookies.sp_shop;
  const hasToken = !!req.signedCookies.sp_token;
  if (shop && hasToken) {
    res.json({ connected: true, shop });
  } else {
    res.json({ connected: false });
  }
});

// Disconnect store — clear cookies
app.get('/disconnect', (req, res) => {
  res.clearCookie('sp_shop');
  res.clearCookie('sp_token');
  res.clearCookie('sp_scope');
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