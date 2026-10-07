
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
loadDotEnv();

const PORT = Number(process.env.PORT || 3000);
const RESULT_LIMIT = Math.max(1, Math.min(10, Number(process.env.SEARCH_RESULT_LIMIT || 5)));
const FETCH_LIMIT = Math.max(1, Math.min(8, Number(process.env.PAGE_FETCH_LIMIT_PER_RETAILER || 4)));
const CACHE_MS = Number(process.env.CACHE_MINUTES || 15) * 60 * 1000;
const PUBLIC = path.join(ROOT, "public");
const retailers = JSON.parse(fs.readFileSync(path.join(ROOT, "retailers.json"), "utf8"));
const cache = new Map();
const strategyCache = new Map();
const DIRECT_SEARCH_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.DIRECT_SEARCH_CONCURRENCY || 5)));
const SEARCH_STRATEGY_LIMIT = Math.max(1, Math.min(7, Number(process.env.SEARCH_STRATEGY_LIMIT || 5)));
const REQUEST_TIMEOUT_MS = Math.max(4000, Math.min(20000, Number(process.env.REQUEST_TIMEOUT_MS || 10000)));


const MIME = {
  ".html":"text/html; charset=utf-8",
  ".css":"text/css; charset=utf-8",
  ".js":"application/javascript; charset=utf-8",
  ".json":"application/json; charset=utf-8",
  ".svg":"image/svg+xml",
  ".png":"image/png",
  ".ico":"image/x-icon"
};

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (u.pathname === "/health") {
      return json(res, 200, {ok:true, service:"cigar-price-scout"});
    }

    if (u.pathname === "/api/config") {
      return json(res, 200, {
        retailers,
        provider: "Direct retailer search (free)",
        searchMode: "direct"
      });
    }

    if (u.pathname === "/api/search") {
      if (req.method !== "GET") return json(res, 405, {error:"Method not allowed"});
      return await handleSearch(u, res);
    }

    return serveStatic(u.pathname, res);
  } catch (e) {
    console.error(e);
    return json(res, 500, {error:"Server error"});
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Cigar Price Scout running on port ${PORT}`);
  console.log(`Search mode: direct retailer search; no paid search API required`);
});

async function handleSearch(u, res) {
  const q = cleanQuery(u.searchParams.get("q") || "");
  const pack = String(u.searchParams.get("pack") || "all");
  const mode = String(u.searchParams.get("mode") || "exact");
  const selectedRetailers = String(u.searchParams.get("retailers") || "")
    .split(",").map(x=>x.trim()).filter(Boolean);

  if (q.length < 3) return json(res, 400, {error:"Enter a cigar name."});
  if (!["all","single","5pack","box"].includes(pack)) return json(res, 400, {error:"Invalid package filter."});
  if (!["exact","similar"].includes(mode)) return json(res, 400, {error:"Invalid match mode."});


  const active = selectedRetailers.length
    ? retailers.filter(r=>selectedRetailers.includes(r.id))
    : retailers;

  const key = JSON.stringify({q,pack,mode,active:active.map(r=>r.id).sort()});
  const cached = cache.get(key);
  if (cached && Date.now()-cached.at < CACHE_MS) return json(res, 200, {...cached.data,cached:true});

  const started = Date.now();
  const perRetailer = await mapLimit(active, DIRECT_SEARCH_CONCURRENCY, r=>searchRetailer(r,q));
  let offers = perRetailer.flatMap(x=>x.offers);
  const statuses = perRetailer.map(x=>({retailer:x.retailer,status:x.status,pages:x.pages,strategy:x.strategy||null,error:x.error||null}));

  offers = dedupeOffers(offers)
    .filter(o=>packageMatches(o.packageType,pack))
    .filter(o=>mode==="similar" ? o.matchScore>=0.34 : o.matchScore>=0.52)
    .sort((a,b)=>{
      const ap=Number.isFinite(a.price)?a.price:1e9;
      const bp=Number.isFinite(b.price)?b.price:1e9;
      if (pack==="all") {
        const au=Number.isFinite(a.unitPrice)?a.unitPrice:ap;
        const bu=Number.isFinite(b.unitPrice)?b.unitPrice:bp;
        return au-bu || ap-bp;
      }
      return ap-bp || b.matchScore-a.matchScore;
    });

  const data = {
    query:q,pack,mode,searchedRetailers:active.length,resultCount:offers.length,
    ms:Date.now()-started,offers:offers.slice(0,100),statuses
  };
  cache.set(key,{at:Date.now(),data});
  return json(res,200,data);
}

async function searchRetailer(retailer, query) {
  let search;
  try {
    search = await directRetailerSearch(retailer, query);
  } catch (e) {
    return {
      retailer:retailer.name,
      status:classifySearchError(e),
      pages:0,
      strategy:null,
      error:String(e.message||e),
      offers:[]
    };
  }

  const candidates = search.candidates.slice(0, FETCH_LIMIT);
  const pages = await mapLimit(candidates, 2, async r => {
    try {
      return await extractPageOffers(retailer, query, r);
    } catch (e) {
      return extractSnippetOffers(retailer, query, r, String(e.message||e));
    }
  });

  let offers = pages.flat().filter(Boolean);

  // Some retailer search pages show full single/box pricing directly.
  // When product links are absent or blocked, extract those visible offers as a fallback.
  if (!offers.length && search.searchPage) {
    offers.push(...extractSearchPageOffers(retailer, query, search.searchPage.url, search.searchPage.html));
  }

  return {
    retailer:retailer.name,
    status:offers.length ? "ok" : (candidates.length ? "no_price_found" : "no_search_results"),
    pages:candidates.length,
    strategy:search.strategy,
    offers
  };
}

async function directRetailerSearch(retailer, query) {
  const known = knownSearchUrls(retailer, query);
  const cached = strategyCache.get(retailer.id);
  const strategies = [];
  if (cached) strategies.push(cached);
  for (const x of known) if (!strategies.includes(x)) strategies.push(x);

  let lastError = null;
  let bestEmpty = null;
  for (const strategy of strategies.slice(0, SEARCH_STRATEGY_LIMIT)) {
    const url = buildSearchUrl(retailer, strategy, query);
    try {
      const page = await fetchRetailerHtml(url, retailer.domain);
      const candidates = extractCandidateProductLinks(page.html, page.url, retailer, query);
      const inlineProducts = extractJsonLdCandidateLinks(page.html, page.url, retailer, query);
      const merged = dedupeCandidates([...candidates, ...inlineProducts])
        .sort((a,b)=>b.matchScore-a.matchScore)
        .slice(0, RESULT_LIMIT);

      if (merged.length) {
        strategyCache.set(retailer.id, strategy);
        return {strategy,url:page.url,candidates:merged,searchPage:page};
      }

      // Remember a valid search page even if product links are rendered by JS.
      if (!bestEmpty && page.looksLikeSearch) bestEmpty = {strategy,url:page.url,candidates:[],searchPage:page};
    } catch (e) {
      lastError = e;
      if (String(e.message||e).includes("HTTP 403") || String(e.message||e).includes("HTTP 429")) break;
    }
  }

  if (bestEmpty) return bestEmpty;
  throw lastError || new Error("No usable direct search page");
}

function knownSearchUrls(retailer, query) {
  // A few stores use distinctive search parameter names. All others are probed
  // through common ecommerce search patterns, then the successful strategy is cached.
  const overrides = {
    neptune:["neptune_text"],
    cigarpage:["shopify"],
    smallbatch:["shopify"],
    foxcigar:["shopify"],
    cigarsdaily:["shopify"],
    luxurycigarclub:["shopify"],
    mardo:["shopify"],
    perfectblend:["shopify"],
    cityofcigars:["shopify"]
  };
  const base = overrides[retailer.id] || [];
  return [...base, "shopify", "bigcommerce", "magento", "woocommerce", "query", "searchresults"]
    .filter((x,i,a)=>a.indexOf(x)===i);
}

function buildSearchUrl(retailer, strategy, query) {
  const base = `https://${retailer.domain}`;
  const q = encodeURIComponent(query);
  switch(strategy) {
    case "neptune_text": return `${base}/search?nb=24&pg=1&text=${q}`;
    case "shopify": return `${base}/search?type=product&q=${q}`;
    case "bigcommerce": return `${base}/search.php?search_query=${q}`;
    case "magento": return `${base}/catalogsearch/result/?q=${q}`;
    case "woocommerce": return `${base}/?s=${q}&post_type=product`;
    case "query": return `${base}/search?query=${q}`;
    case "searchresults": return `${base}/search-results?q=${q}`;
    default: return `${base}/search?q=${q}`;
  }
}

async function fetchRetailerHtml(url, domain) {
  const resp = await fetchWithTimeout(url, {
    headers:{
      "User-Agent":"Mozilla/5.0 (compatible; CigarPriceScout/2.0; personal price comparison)",
      "Accept":"text/html,application/xhtml+xml,application/json;q=0.7,*/*;q=0.5",
      "Accept-Language":"en-US,en;q=0.8"
    },
    redirect:"follow"
  }, REQUEST_TIMEOUT_MS);

  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const finalUrl = resp.url || url;
  if (!hostMatches(finalUrl, domain)) throw new Error("Search redirected off retailer domain");
  const type = resp.headers.get("content-type") || "";
  if (!type.includes("text/html") && !type.includes("application/xhtml+xml")) throw new Error("Search returned non-HTML content");
  const html = await resp.text();
  if (html.length > 5_000_000) throw new Error("Search page too large");
  const bodyText = textClean(stripTags(extractBody(html))).slice(0,100000);
  return {
    url:finalUrl,
    html,
    bodyText,
    looksLikeSearch:/search|results|products|cigar/i.test(firstTagText(html,"title")+" "+bodyText.slice(0,5000))
  };
}

function extractCandidateProductLinks(html, baseUrl, retailer, query) {
  const out=[];
  const re=/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/ig;
  let m;
  while ((m=re.exec(html))) {
    let href=decodeHtml(m[1]).trim();
    const label=textClean(stripTags(m[2]));
    if (!href || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:")) continue;
    let url;
    try { url=new URL(href,baseUrl).toString(); } catch { continue; }
    if (!hostMatches(url,retailer.domain)) continue;
    if (isObviouslyNonProductUrl(url)) continue;
    const match=scoreMatch(query,`${label} ${new URL(url).pathname.replace(/[-_/]+/g," ")}`);
    if (match.score < 0.25) continue;
    out.push({title:label||query,url,snippet:label,matchScore:match.score});
  }
  return out;
}

function extractJsonLdCandidateLinks(html, baseUrl, retailer, query) {
  const out=[];
  for (const product of extractJsonLdProducts(html)) {
    const name=textClean(product.name||"");
    const rawUrl=product.url || product['@id'];
    if (!rawUrl) continue;
    let url;
    try { url=new URL(rawUrl,baseUrl).toString(); } catch { continue; }
    if (!hostMatches(url,retailer.domain)) continue;
    const match=scoreMatch(query,name||url);
    if (match.score < 0.25) continue;
    out.push({title:name||query,url,snippet:name,matchScore:match.score});
  }
  return out;
}

function dedupeCandidates(items) {
  const map=new Map();
  for (const item of items) {
    const key=canonicalUrl(item.url);
    const old=map.get(key);
    if (!old || item.matchScore > old.matchScore) map.set(key,item);
  }
  return [...map.values()];
}

function isObviouslyNonProductUrl(url) {
  try {
    const p=new URL(url).pathname.toLowerCase();
    return /\/(cart|checkout|account|login|register|blog|blogs|article|articles|pages|page|collections|category|categories|brands?|contact|about|faq|wishlist|search)(\/|$)/.test(p)
      || /\.(jpg|jpeg|png|gif|svg|css|js|pdf)$/i.test(p);
  } catch { return true; }
}

function extractSearchPageOffers(retailer, query, url, html) {
  const title=firstTagText(html,"title") || `${retailer.name} search results`;
  const text=textClean(stripTags(extractBody(html))).slice(0,350000);
  const scoredTitle = `${query} ${title}`;
  const availability=detectAvailability(text);
  const offers=offersNearPackageLabels(retailer,query,url,scoredTitle,text,availability);
  return offers.map(o=>({...o, confidence:o.confidence==="medium"?"low":o.confidence, source:"retailer_search_page"}));
}

function classifySearchError(e) {
  const s=String(e && (e.message||e) || "");
  if (/HTTP 403|HTTP 401|captcha|access denied/i.test(s)) return "blocked";
  if (/HTTP 429|rate/i.test(s)) return "rate_limited";
  if (/abort|timeout/i.test(s)) return "timeout";
  return "search_error";
}

async function extractPageOffers(retailer,query,searchResult) {
  const resp=await fetchWithTimeout(searchResult.url,{
    headers:{
      "User-Agent":"Mozilla/5.0 (compatible; CigarPriceScout/2.0; personal price comparison)",
      "Accept":"text/html,application/xhtml+xml"
    },
    redirect:"follow"
  },REQUEST_TIMEOUT_MS);

  if(!resp.ok) throw new Error(`page ${resp.status}`);
  const type=resp.headers.get("content-type")||"";
  if(!type.includes("text/html")) throw new Error("not_html");
  const html=await resp.text();
  if(html.length>4_000_000) throw new Error("page_too_large");

  const pageTitle=textClean(firstTagText(html,"h1") || firstTagText(html,"title") || searchResult.title);
  const bodyText=textClean(stripTags(extractBody(html))).slice(0,350000);
  const availability=detectAvailability(bodyText);

  let offers=[];
  for(const node of extractJsonLdProducts(html)) {
    offers.push(...offersFromProductJson(retailer,query,searchResult.url,node,pageTitle,availability));
  }

  offers.push(...offersNearPackageLabels(retailer,query,searchResult.url,pageTitle,bodyText,availability));

  if(!offers.length) {
    const metas=extractMetaPrices(html).filter(Number.isFinite);
    if(metas.length) {
      const pkg=classifyPackage(pageTitle+" "+bodyText.slice(0,5000));
      offers.push(makeOffer({
        retailer,query,url:searchResult.url,title:pageTitle,price:Math.min(...metas),
        packageType:pkg.type,packageCount:pkg.count,availability,confidence:"medium",source:"meta"
      }));
    }
  }

  if(!offers.length) return extractSnippetOffers(retailer,query,searchResult);
  return offers.filter(Boolean);
}

function extractJsonLdProducts(html) {
  const out=[];
  const re=/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/ig;
  let m;
  while((m=re.exec(html))) {
    const raw=decodeHtml(m[1].trim());
    let parsed;
    try { parsed=JSON.parse(raw); } catch { continue; }
    walk(parsed,obj=>{
      const t=obj&&obj["@type"];
      const types=Array.isArray(t)?t:[t];
      if(types.some(x=>String(x||"").toLowerCase()==="product")) out.push(obj);
    });
  }
  return out;
}

function walk(value,visit) {
  if(!value||typeof value!=="object") return;
  visit(value);
  if(Array.isArray(value)) value.forEach(x=>walk(x,visit));
  else Object.values(value).forEach(x=>walk(x,visit));
}

function offersFromProductJson(retailer,query,url,product,fallbackTitle,availability) {
  const title=textClean(product.name||fallbackTitle);
  const raw=product.offers ? (Array.isArray(product.offers)?product.offers:[product.offers]) : [];
  const out=[];

  for(const o of raw) {
    if(!o||typeof o!=="object") continue;
    const candidatePrices=[o.price,o.lowPrice,o.highPrice,o.priceSpecification?.price]
      .map(parsePrice).filter(Number.isFinite);
    if(!candidatePrices.length) continue;

    const label=textClean([o.name,o.description,o.sku,product.sku,title].filter(Boolean).join(" "));
    const pkg=classifyPackage(label);
    const avail=detectAvailability(String(o.availability||""))||availability;

    out.push(makeOffer({
      retailer,query,url,title,price:Math.min(...candidatePrices),
      packageType:pkg.type,packageCount:pkg.count,availability:avail,confidence:"high",source:"jsonld"
    }));
  }
  return out.filter(Boolean);
}

function offersNearPackageLabels(retailer,query,url,title,text,availability) {
  const out=[];
  const patterns=[
    {type:"single",count:1,re:/\b(single(?:\s+cigar)?|individual(?:\s+cigar)?|each)\b/ig},
    {type:"5pack",count:5,re:/\b(5[\s-]?(?:pack|pk)|pack\s+of\s+5|five[\s-]?pack)\b/ig},
    {type:"box",count:null,re:/\bbox(?:\s+of)?\s*(\d{1,2})?\b/ig}
  ];

  for(const p of patterns) {
    let m,n=0;
    while((m=p.re.exec(text)) && n++<12) {
      const start=Math.max(0,m.index-90);
      const end=Math.min(text.length,m.index+m[0].length+170);
      const window=text.slice(start,end);
      const prices=[...window.matchAll(/\$\s*([0-9]{1,4}(?:,[0-9]{3})*(?:\.[0-9]{2})?)/g)]
        .map(x=>parsePrice(x[1])).filter(x=>Number.isFinite(x)&&x>=1&&x<=5000);
      if(!prices.length) continue;

      let count=p.count;
      if(p.type==="box"&&m[1]) count=Number(m[1]);

      out.push(makeOffer({
        retailer,query,url,title,price:Math.min(...prices),
        packageType:p.type,packageCount:count,availability,confidence:"medium",source:"page_text"
      }));
    }
  }
  return out.filter(Boolean);
}

function extractSnippetOffers(retailer,query,r,fetchError=null) {
  const text=textClean(`${r.title||""} ${r.snippet||""}`);
  const prices=[...text.matchAll(/\$\s*([0-9]{1,4}(?:,[0-9]{3})*(?:\.[0-9]{2})?)/g)]
    .map(m=>parsePrice(m[1])).filter(Number.isFinite);
  if(!prices.length) return [];

  const pkg=classifyPackage(text);
  const offer=makeOffer({
    retailer,query,url:r.url,title:textClean(r.title||query),price:Math.min(...prices),
    packageType:pkg.type,packageCount:pkg.count,availability:detectAvailability(text),
    confidence:"low",source:"search_snippet"
  });
  if(offer&&fetchError) offer.note="Retailer page could not be parsed; price came from the search-result snippet.";
  return offer?[offer]:[];
}

function makeOffer({retailer,query,url,title,price,packageType,packageCount,availability,confidence,source}) {
  if(!Number.isFinite(price)||price<=0) return null;
  const match=scoreMatch(query,title);
  return {
    retailer:retailer.name,retailerId:retailer.id,domain:retailer.domain,title,url,
    price:round2(price),packageType,packageCount,packageLabel:packageLabel(packageType,packageCount),
    unitPrice:packageCount?round2(price/packageCount):null,
    availability:availability||"unknown",matchScore:round3(match.score),matchReason:match.reason,
    confidence,source
  };
}

function classifyPackage(text) {
  const s=textClean(text).toLowerCase();
  let m;
  if(/\b(pack\s+of\s+5|5[\s-]?(?:pack|pk)|five[\s-]?pack)\b/.test(s)) return {type:"5pack",count:5};
  if((m=s.match(/\bbox(?:\s+of)?\s*(\d{1,2})\b/))) return {type:"box",count:Number(m[1])};
  if(/\bbox\b/.test(s)) return {type:"box",count:null};
  if((m=s.match(/\bpack(?:\s+of)?\s*(\d{1,2})\b/))) {
    const n=Number(m[1]); return n===5?{type:"5pack",count:5}:{type:"pack",count:n};
  }
  if(/\b(single(?:\s+cigar)?|individual(?:\s+cigar)?|each)\b/.test(s)) return {type:"single",count:1};
  return {type:"unknown",count:null};
}

function packageLabel(type,count) {
  if(type==="single") return "Single";
  if(type==="5pack") return "5-pack";
  if(type==="box") return count?`Box of ${count}`:"Box";
  if(type==="pack") return count?`Pack of ${count}`:"Pack";
  return "Unclassified";
}

function packageMatches(type,wanted) {
  if(wanted==="all") return true;
  if(wanted==="single") return type==="single";
  if(wanted==="5pack") return type==="5pack";
  if(wanted==="box") return type==="box";
  return true;
}

function scoreMatch(query,title) {
  const q=normalizeName(query),t=normalizeName(title);
  const qTokens=tokenSet(q),tTokens=tokenSet(t);
  const inter=[...qTokens].filter(x=>tTokens.has(x)).length;
  const union=new Set([...qTokens,...tTokens]).size||1;
  const jaccard=inter/union;
  const dice=diceCoefficient(q,t);
  let score=0.58*jaccard+0.42*dice;

  const qs=extractSize(query),ts=extractSize(title);
  const notes=[];

  if(qs.ring&&ts.ring) {
    if(qs.ring===ts.ring){score+=0.08;notes.push(`ring ${qs.ring} matches`);}
    else {score-=0.24;notes.push(`ring ${ts.ring} differs from ${qs.ring}`);}
  }

  if(qs.length&&ts.length) {
    if(Math.abs(qs.length-ts.length)<0.08){score+=0.08;notes.push("length matches");}
    else if(Math.abs(qs.length-ts.length)>0.3){score-=0.18;notes.push("length differs");}
  }

  const coverage=qTokens.size?inter/qTokens.size:0;
  score+=coverage*0.18;
  score=Math.max(0,Math.min(1,score));

  return {
    score,
    reason:notes.length?notes.join("; "):`${Math.round(coverage*100)}% of search terms matched`
  };
}

function normalizeName(s) {
  return textClean(String(s||"").toLowerCase())
    .replace(/[×]/g,"x")
    .replace(/\b(cigar|cigars|premium|handmade|sampler|free shipping|sale)\b/g," ")
    .replace(/\b(single|box|pack|pk)\s*(?:of\s*)?\d*\b/g," ")
    .replace(/[^a-z0-9./x -]/g," ")
    .replace(/\s+/g," ").trim();
}

function tokenSet(s) {
  const stop=new Set(["the","and","of","by","a","an","x"]);
  return new Set(s.split(/\s+/).filter(x=>x.length>1&&!stop.has(x)&&!/^\$?\d+(?:\.\d+)?$/.test(x)));
}

function diceCoefficient(a,b) {
  const aa=a.replace(/\s+/g," "),bb=b.replace(/\s+/g," ");
  if(aa===bb) return 1;
  if(aa.length<2||bb.length<2) return 0;
  const map=new Map();
  for(let i=0;i<aa.length-1;i++){const bg=aa.slice(i,i+2);map.set(bg,(map.get(bg)||0)+1);}
  let hits=0;
  for(let i=0;i<bb.length-1;i++){const bg=bb.slice(i,i+2),c=map.get(bg)||0;if(c>0){hits++;map.set(bg,c-1);}}
  return 2*hits/((aa.length-1)+(bb.length-1));
}

function extractSize(s) {
  const x=String(s||"").toLowerCase().replace(/[×]/g,"x");
  const m=x.match(/(\d+(?:\s+\d+\/\d+|\.\d+)?)\s*(?:["”])?\s*x\s*(\d{2})\b/);
  if(!m) return {};
  return {length:parseMixedNumber(m[1]),ring:Number(m[2])};
}

function parseMixedNumber(s) {
  s=String(s).trim();
  if(/^\d+(?:\.\d+)?$/.test(s)) return Number(s);
  const m=s.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  return m?Number(m[1])+Number(m[2])/Number(m[3]):null;
}

function detectAvailability(text) {
  const s=String(text||"").toLowerCase();
  if(/out of stock|sold out|unavailable|backorder/.test(s)) return "out_of_stock";
  if(/in stock|add to cart|ships/.test(s)) return "in_stock";
  return "unknown";
}

function dedupeOffers(offers) {
  const seen=new Map();
  for(const o of offers.filter(Boolean)) {
    const key=[o.retailerId,canonicalUrl(o.url),o.packageType,o.packageCount||"",o.price].join("|");
    const old=seen.get(key);
    if(!old||confidenceRank(o.confidence)>confidenceRank(old.confidence)) seen.set(key,o);
  }
  return [...seen.values()];
}
function confidenceRank(x){return x==="high"?3:x==="medium"?2:1;}

async function mapLimit(items,limit,fn) {
  const out=new Array(items.length);
  let next=0;
  const workers=Array.from({length:Math.min(limit,items.length)},async()=>{
    while(true){const i=next++;if(i>=items.length)break;out[i]=await fn(items[i],i);}
  });
  await Promise.all(workers);
  return out;
}

async function fetchWithTimeout(url,opts={},ms=12000) {
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),ms);
  try{return await fetch(url,{...opts,signal:controller.signal});}
  finally{clearTimeout(timer);}
}

function extractMetaPrices(html) {
  const out=[];
  const patterns=[
    /<meta\b[^>]*property=["']product:price:amount["'][^>]*content=["']([^"']+)["'][^>]*>/ig,
    /<meta\b[^>]*content=["']([^"']+)["'][^>]*property=["']product:price:amount["'][^>]*>/ig,
    /<meta\b[^>]*itemprop=["']price["'][^>]*content=["']([^"']+)["'][^>]*>/ig,
    /<meta\b[^>]*content=["']([^"']+)["'][^>]*itemprop=["']price["'][^>]*>/ig
  ];
  for(const re of patterns){let m;while((m=re.exec(html)))out.push(parsePrice(m[1]));}
  return out;
}

function firstTagText(html,tag) {
  const re=new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`,"i");
  const m=html.match(re);
  return m?decodeHtml(stripTags(m[1])):"";
}

function extractBody(html) {
  const m=html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return m?m[1]:html;
}

function stripTags(s) {
  return decodeHtml(String(s||"")
    .replace(/<script\b[\s\S]*?<\/script>/ig," ")
    .replace(/<style\b[\s\S]*?<\/style>/ig," ")
    .replace(/<[^>]+>/g," "));
}

function decodeHtml(s) {
  return String(s||"")
    .replace(/&nbsp;/gi," ")
    .replace(/&amp;/gi,"&")
    .replace(/&quot;/gi,'"')
    .replace(/&#39;|&apos;/gi,"'")
    .replace(/&lt;/gi,"<")
    .replace(/&gt;/gi,">")
    .replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(Number(n)));
}

function hostMatches(url,domain) {
  try {
    const h=new URL(url).hostname.toLowerCase().replace(/^www\./,"");
    const d=domain.toLowerCase().replace(/^www\./,"");
    return h===d||h.endsWith("."+d)||d.endsWith("."+h);
  } catch {return false;}
}

function safeHttpUrl(url){try{return ["http:","https:"].includes(new URL(url).protocol);}catch{return false;}}
function canonicalUrl(url){try{const u=new URL(url);u.hash="";["utm_source","utm_medium","utm_campaign","source","src"].forEach(k=>u.searchParams.delete(k));return u.toString();}catch{return url;}}
function parsePrice(x){if(x==null)return NaN;const m=String(x).replace(/,/g,"").match(/([0-9]{1,4}(?:\.[0-9]{1,2})?)/);return m?Number(m[1]):NaN;}
function textClean(s){return String(s||"").replace(/\s+/g," ").trim();}
function cleanQuery(s){return textClean(s).slice(0,180);}
function round2(n){return Math.round(n*100)/100;}
function round3(n){return Math.round(n*1000)/1000;}

function json(res,status,obj) {
  const body=JSON.stringify(obj);
  res.writeHead(status,{
    "Content-Type":"application/json; charset=utf-8",
    "Cache-Control":"no-store",
    "X-Content-Type-Options":"nosniff"
  });
  res.end(body);
}

function serveStatic(urlPath,res) {
  let rel=decodeURIComponent(urlPath);
  if(rel==="/") rel="/index.html";
  const target=path.normalize(path.join(PUBLIC,rel));
  if(!target.startsWith(PUBLIC)) return textResponse(res,403,"Forbidden");
  let stat;
  try{stat=fs.statSync(target);}catch{return textResponse(res,404,"Not found");}
  if(!stat.isFile()) return textResponse(res,404,"Not found");
  const ext=path.extname(target).toLowerCase();
  res.writeHead(200,{
    "Content-Type":MIME[ext]||"application/octet-stream",
    "Cache-Control":ext===".html"?"no-cache":"public, max-age=300",
    "X-Content-Type-Options":"nosniff"
  });
  fs.createReadStream(target).pipe(res);
}

function textResponse(res,status,text) {
  res.writeHead(status,{"Content-Type":"text/plain; charset=utf-8"});
  res.end(text);
}

function loadDotEnv() {
  const file=path.join(ROOT,".env");
  if(!fs.existsSync(file)) return;
  for(const line of fs.readFileSync(file,"utf8").split(/\r?\n/)) {
    const s=line.trim();
    if(!s||s.startsWith("#")) continue;
    const i=s.indexOf("=");
    if(i<1) continue;
    const k=s.slice(0,i).trim();
    const v=s.slice(i+1).trim().replace(/^["']|["']$/g,"");
    if(!(k in process.env)) process.env[k]=v;
  }
}
