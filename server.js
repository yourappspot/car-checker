require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const MARKETCHECK_API_KEY = String(process.env.MARKETCHECK_API_KEY || '').trim();
const cache = new Map();
const NHTSA_VEHICLE_TYPES = [
  'car',
  'truck',
  'multipurpose passenger vehicle'
];

async function cachedGet(key, url) {
  if (cache.has(key)) return cache.get(key);

  const res = await axios.get(url);
  cache.set(key, res.data);

  return res.data;
}

async function cachedAxiosGet(key, url, options) {
  if (cache.has(key)) return cache.get(key);

  const res = await axios.get(url, options);
  cache.set(key, res.data);

  return res.data;
}

function sortUnique(values) {
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}

function facetItems(data, field) {
  return (data.facets?.[field] || [])
    .map(item => item.item)
    .filter(Boolean);
}

async function getMarketCheckMakes() {
  if (!MARKETCHECK_API_KEY) return [];

  const data = await cachedAxiosGet(
    'marketcheck-makes',
    'https://api.marketcheck.com/v2/search/car/active',
    {
      params: {
        api_key: MARKETCHECK_API_KEY,
        rows: 0,
        facets: 'make|0|1000',
        facet_sort: 'index'
      }
    }
  );

  return sortUnique(facetItems(data, 'make'));
}

async function getMarketCheckModels(year, make) {
  if (!MARKETCHECK_API_KEY) return [];

  const data = await cachedAxiosGet(
    `marketcheck-models-${year}-${make}`,
    'https://api.marketcheck.com/v2/search/car/active',
    {
      params: {
        api_key: MARKETCHECK_API_KEY,
        year,
        make,
        rows: 0,
        facets: 'model|0|1000',
        facet_sort: 'index'
      }
    }
  );

  return sortUnique(facetItems(data, 'model'));
}

async function getNhtsaMakes() {
  const responses = await Promise.all(
    NHTSA_VEHICLE_TYPES.map(type =>
      cachedGet(
        `makes-${type}`,
        `https://vpic.nhtsa.dot.gov/api/vehicles/GetMakesForVehicleType/${encodeURIComponent(type)}?format=json`
      )
    )
  );

  return sortUnique(
    responses.flatMap(data => data.Results.map(item => item.MakeName))
  );
}

async function getNhtsaModels(year, make) {
  const data = await cachedGet(
    `models-${year}-${make}`,
    `https://vpic.nhtsa.dot.gov/api/vehicles/GetModelsForMakeYear/make/${encodeURIComponent(make)}/modelyear/${year}?format=json`
  );

  return sortUnique(data.Results.map(item => item.Model_Name));
}

function normalizeMarketCheckModel(make, model) {
  const mk = String(make || '').toLowerCase();

  let md = String(model || '')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

  if (mk === 'ford') {
    if (/f\s*-?\s*150/i.test(md)) return 'F-150';
    if (/f\s*-?\s*250/i.test(md)) return 'F-250';
    if (/f\s*-?\s*350/i.test(md)) return 'F-350';
    if (/f\s*-?\s*450/i.test(md)) return 'F-450';
    if (/f\s*-?\s*550/i.test(md)) return 'F-550';
  }

  return md;
}

function buildMarketCheckParams({ year, make, model, zip, radius }) {
  const marketModel = normalizeMarketCheckModel(make, model);

  const params = {
    api_key: MARKETCHECK_API_KEY,
    year,
    make,
    zip,
    radius: radius || 75,
    rows: 50
  };

  if (String(make || '').toLowerCase() === 'ford') {
    if (/^F-?250$/i.test(marketModel)) {
      params.model = 'F-250 Super Duty';
      return params;
    }

    if (/^F-?350$/i.test(marketModel)) {
      params.model = 'F-350 Super Duty';
      return params;
    }

    if (/^F-?450$/i.test(marketModel)) {
      params.model = 'F-450 Super Duty';
      return params;
    }

    if (/^F-?550$/i.test(marketModel)) {
      params.model = 'F-550 Super Duty';
      return params;
    }
  }

  params.model = marketModel;
  return params;
}

function redactSensitiveParams(params) {
  return {
    ...params,
    api_key: params.api_key ? '[configured]' : '[missing]'
  };
}

function getMarketCheckError(err) {
  const status = err.response?.status;
  const data = err.response?.data;
  const upstreamMessage =
    typeof data === 'string'
      ? data
      : data?.message || data?.error || data?.detail || data?.status;

  if (status === 401 || status === 403) {
    return 'MarketCheck rejected the API key. Check MARKETCHECK_API_KEY in Coolify and redeploy the service.';
  }

  if (status === 429) {
    return 'MarketCheck rate limit reached. Please wait and try again.';
  }

  if (status === 400 && upstreamMessage) {
    return `MarketCheck could not run that search: ${upstreamMessage}`;
  }

  if (status) {
    return `MarketCheck returned HTTP ${status}. Please try again shortly.`;
  }

  return 'Failed loading comparable listings.';
}

app.get('/api/years', (req, res) => {
  const currentYear = new Date().getFullYear() + 1;
  const years = [];

  for (let y = currentYear; y >= 1995; y--) {
    years.push(y);
  }

  res.json({ years });
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    marketcheckApiKeyConfigured: Boolean(MARKETCHECK_API_KEY)
  });
});

app.get('/api/makes', async (req, res) => {
  try {
    let makes = [];

    try {
      makes = await getMarketCheckMakes();
    } catch (err) {
      console.warn('MarketCheck make facets unavailable; falling back to NHTSA:', {
        status: err.response?.status,
        data: err.response?.data || err.message
      });
    }

    if (!makes.length) {
      makes = await getNhtsaMakes();
    }

    res.json({ makes });
  } catch (err) {
    console.error(err.response?.data || err.message);

    res.status(500).json({
      error: 'Failed loading makes'
    });
  }
});

app.get('/api/models', async (req, res) => {
  try {
    const { year, make } = req.query;

    if (!year || !make) {
      return res.status(400).json({
        error: 'Missing year or make'
      });
    }

    let models = [];

    try {
      models = await getMarketCheckModels(year, make);
    } catch (err) {
      console.warn('MarketCheck model facets unavailable; falling back to NHTSA:', {
        status: err.response?.status,
        data: err.response?.data || err.message
      });
    }

    if (!models.length) {
      models = await getNhtsaModels(year, make);
    }

    res.json({ models });
  } catch (err) {
    console.error(err.response?.data || err.message);

    res.status(500).json({
      error: 'Failed loading models'
    });
  }
});

app.post('/api/live-comps', async (req, res) => {
  try {
    const {
      year,
      make,
      model,
      zip,
      radius
    } = req.body;

    if (!MARKETCHECK_API_KEY) {
      return res.status(500).json({
        error: 'Missing MARKETCHECK_API_KEY'
      });
    }

    if (!year || !make || !model || !zip) {
      return res.status(400).json({
        error: 'Please complete all fields.'
      });
    }

    const params = buildMarketCheckParams({
      year,
      make,
      model,
      zip,
      radius
    });

    console.log('MarketCheck search params:', redactSensitiveParams(params));

    const response = await axios.get(
      'https://api.marketcheck.com/v2/search/car/active',
      { params }
    );

    const listings = response.data.listings || [];

    const comps = listings
      .filter(car => car.price)
      .map(car => ({
        id: car.id,
        price: Number(car.price),
        miles: car.miles ? Number(car.miles) : null,
        dist: Number(car.dist || 0),

        year: car.year || '',
        make: car.build?.make || make,
        model: car.build?.model || model,
        trim: car.build?.trim || '',

        dealerName: car.dealer?.name || 'Unknown Dealer',
        city: car.dealer?.city || '',
        state: car.dealer?.state || '',

        image: car.media?.photo_links?.[0] || '',
        link: car.vdp_url || ''
      }));

    if (!comps.length) {
      return res.json({
        error: 'No comparable listings found.'
      });
    }

    res.json({
      total: comps.length,
      comps
    });
  } catch (err) {
    console.error('MarketCheck request failed:', {
      status: err.response?.status,
      data: err.response?.data || err.message
    });

    const status = err.response?.status;

    res.status(status && status >= 400 && status < 500 ? status : 500).json({
      error: getMarketCheckError(err)
    });
  }
});

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Running on port ${PORT}`);
});
