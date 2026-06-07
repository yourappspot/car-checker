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
const MARKETCHECK_SEARCH_PAGE_SIZE = 50;
const MARKETCHECK_SEARCH_MAX_LISTINGS = 300;
const MARKETCHECK_PAGE_DELAY_MS = 250;
const MARKETCHECK_RATE_LIMIT_RETRIES = 2;
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getUpstreamMessage(err) {
  const data = err.response?.data;

  return typeof data === 'string'
    ? data
    : data?.message || data?.error || data?.detail || data?.status || '';
}

function getRetryAfterMs(headers = {}) {
  const retryAfter = Number(headers['retry-after']);

  if (!Number.isFinite(retryAfter) || retryAfter <= 0 || retryAfter > 10) {
    return null;
  }

  return retryAfter * 1000;
}

function isShortMarketCheckThrottle(err) {
  if (err.response?.status !== 429) return false;

  const message = getUpstreamMessage(err).toLowerCase();

  return !message.includes('monthly') && !message.includes('quota');
}

async function marketCheckGet(url, options) {
  for (let attempt = 0; attempt <= MARKETCHECK_RATE_LIMIT_RETRIES; attempt++) {
    try {
      return await axios.get(url, options);
    } catch (err) {
      if (!isShortMarketCheckThrottle(err) || attempt === MARKETCHECK_RATE_LIMIT_RETRIES) {
        throw err;
      }

      const retryDelayMs =
        getRetryAfterMs(err.response?.headers) || MARKETCHECK_PAGE_DELAY_MS * (attempt + 2);

      console.warn('MarketCheck throttled request; retrying shortly:', {
        attempt: attempt + 1,
        retryDelayMs,
        data: err.response?.data
      });

      await sleep(retryDelayMs);
    }
  }
}

function sortUnique(values) {
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}

const COMMON_MAKES = [
  'Acura',
  'Audi',
  'BMW',
  'Buick',
  'Cadillac',
  'Chevrolet',
  'Chrysler',
  'Dodge',
  'Ford',
  'GMC',
  'Honda',
  'Hyundai',
  'Jeep',
  'Kia',
  'Lexus',
  'Lincoln',
  'Mazda',
  'Mercedes-Benz',
  'Nissan',
  'Ram',
  'Subaru',
  'Tesla',
  'Toyota',
  'Volkswagen'
];

const COMMON_MODELS_BY_MAKE = {
  chevrolet: ['Colorado', 'Equinox', 'Malibu', 'Silverado 1500', 'Silverado 2500HD', 'Silverado 3500HD', 'Suburban', 'Tahoe', 'Trailblazer', 'Traverse'],
  dodge: ['Challenger', 'Charger', 'Durango', 'Grand Caravan', 'Journey', 'Ram 1500', 'Ram 2500', 'Ram 3500'],
  ford: ['Bronco', 'Bronco Sport', 'Edge', 'Escape', 'Expedition', 'Explorer', 'F-150', 'F-250', 'F-350', 'F-450', 'Maverick', 'Mustang', 'Ranger', 'Super Duty', 'Transit'],
  gmc: ['Acadia', 'Canyon', 'Savana', 'Sierra 1500', 'Sierra 2500HD', 'Sierra 3500HD', 'Terrain', 'Yukon'],
  ram: ['1500', '2500', '3500', '4500', '5500', 'ProMaster', 'ProMaster City', 'Ram 1500', 'Ram 2500', 'Ram 3500'],
  toyota: ['4Runner', 'Camry', 'Corolla', 'Highlander', 'RAV4', 'Sequoia', 'Sienna', 'Tacoma', 'Tundra']
};

function getCommonModels(make) {
  return COMMON_MODELS_BY_MAKE[String(make || '').toLowerCase()] || [];
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
    rows: MARKETCHECK_SEARCH_PAGE_SIZE,
    start: 0,
    nodedup: true,
    sort_by: 'dist',
    sort_order: 'asc'
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

async function fetchMarketCheckListings(params) {
  const listings = [];
  let numFound = null;

  for (
    let start = 0;
    start < MARKETCHECK_SEARCH_MAX_LISTINGS;
    start += MARKETCHECK_SEARCH_PAGE_SIZE
  ) {
    const pageParams = {
      ...params,
      rows: MARKETCHECK_SEARCH_PAGE_SIZE,
      start
    };

    console.log('MarketCheck search params:', redactSensitiveParams(pageParams));

    let response;

    try {
      response = await marketCheckGet(
        'https://api.marketcheck.com/v2/search/car/active',
        { params: pageParams }
      );
    } catch (err) {
      if (start > 0 && err.response?.status === 422 && listings.length) {
        console.warn('MarketCheck pagination stopped at subscription limit:', {
          status: err.response.status,
          data: err.response.data
        });
        break;
      }

      throw err;
    }

    const pageListings = response.data.listings || [];
    numFound = Number(response.data.num_found ?? numFound ?? pageListings.length);

    listings.push(...pageListings);

    if (
      !pageListings.length ||
      listings.length >= MARKETCHECK_SEARCH_MAX_LISTINGS ||
      listings.length >= numFound ||
      pageListings.length < MARKETCHECK_SEARCH_PAGE_SIZE
    ) {
      break;
    }

    await sleep(MARKETCHECK_PAGE_DELAY_MS);
  }

  return {
    listings: listings.slice(0, MARKETCHECK_SEARCH_MAX_LISTINGS),
    numFound
  };
}

function getListingKey(car) {
  return [
    car.id,
    car.vin,
    car.stock_no,
    car.source
  ]
    .map(value => String(value || '').trim().toLowerCase())
    .filter(Boolean)
    .join('|');
}

function mergeListings(primaryListings, extraListings) {
  const seen = new Set();
  const merged = [];

  [...primaryListings, ...extraListings].forEach(car => {
    const key = getListingKey(car);

    if (key && seen.has(key)) return;

    if (key) seen.add(key);
    merged.push(car);
  });

  return merged;
}

function getExactLookupParams(params, query) {
  const value = String(query || '').trim();
  const normalized = value.replace(/[^a-z0-9]/gi, '').toUpperCase();

  if (/^[A-HJ-NPR-Z0-9]{17}$/.test(normalized)) {
    return {
      api_key: MARKETCHECK_API_KEY,
      vin: normalized,
      rows: MARKETCHECK_SEARCH_PAGE_SIZE,
      nodedup: true
    };
  }

  if (/^[A-Z0-9-]{4,20}$/i.test(value)) {
    return {
      ...params,
      stock_no: value,
      rows: MARKETCHECK_SEARCH_PAGE_SIZE,
      start: 0
    };
  }

  return null;
}

async function fetchExactIdentifierListings(params, query) {
  const lookupParams = getExactLookupParams(params, query);

  if (!lookupParams) {
    return {
      listings: [],
      searched: false
    };
  }

  console.log('MarketCheck exact lookup params:', redactSensitiveParams(lookupParams));

  const response = await marketCheckGet(
    'https://api.marketcheck.com/v2/search/car/active',
    { params: lookupParams }
  );

  return {
    listings: response.data.listings || [],
    numFound: Number(response.data.num_found ?? 0),
    searched: true
  };
}

function redactSensitiveParams(params) {
  return {
    ...params,
    api_key: params.api_key ? '[configured]' : '[missing]'
  };
}

function getMarketCheckError(err) {
  const status = err.response?.status;
  const upstreamMessage = getUpstreamMessage(err);

  if (status === 401 || status === 403) {
    return 'MarketCheck rejected the API key. Check MARKETCHECK_API_KEY in Coolify and redeploy the service.';
  }

  if (status === 429) {
    if (upstreamMessage.toLowerCase().includes('monthly') || upstreamMessage.toLowerCase().includes('quota')) {
      return 'MarketCheck monthly API quota is exhausted. Check the MarketCheck dashboard for remaining quota.';
    }

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
    const makes = sortUnique([
      ...COMMON_MAKES,
      ...(await getNhtsaMakes())
    ]);

    res.json({
      makes,
      source: 'nhtsa+local'
    });
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

    const models = sortUnique([
      ...getCommonModels(make),
      ...(await getNhtsaModels(year, make))
    ]);

    res.json({
      models,
      source: 'nhtsa+local'
    });
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
      radius,
      dealerFilter
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

    const { listings, numFound } = await fetchMarketCheckListings(params);
    const exactLookup = await fetchExactIdentifierListings(params, dealerFilter);
    const allListings = mergeListings(listings, exactLookup.listings);

    const comps = allListings
      .map(car => {
        const dealer = car.mc_dealership || car.dealer || {};

        return {
          id: car.id,
          vin: car.vin || '',
          stockNo: car.stock_no || '',
          source: car.source || '',
          inventoryType: car.inventory_type || '',
          price: car.price ? Number(car.price) : null,
          miles: car.miles ? Number(car.miles) : null,
          dist: Number(car.dist || 0),

          year: car.year || '',
          make: car.build?.make || make,
          model: car.build?.model || model,
          trim: car.build?.trim || '',

          dealerName: dealer.name || car.dealer?.name || 'Unknown Dealer',
          dealerGroup: dealer.mc_dealership_group_name || dealer.dealership_group_name || '',
          dealerWebsite: dealer.website || car.dealer?.website || '',
          city: dealer.city || car.dealer?.city || '',
          state: dealer.state || car.dealer?.state || '',

          image: car.media?.photo_links?.[0] || '',
          link: car.vdp_url || ''
        };
      });

    if (!comps.length) {
      return res.json({
        error: 'No comparable listings found.'
      });
    }

    res.json({
      total: comps.length,
      numFound,
      exactLookup: {
        searched: exactLookup.searched,
        numFound: exactLookup.numFound ?? null,
        added: allListings.length - listings.length
      },
      limit: MARKETCHECK_SEARCH_MAX_LISTINGS,
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
