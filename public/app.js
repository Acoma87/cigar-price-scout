
const form = document.querySelector("#searchForm");
const qEl = document.querySelector("#query");
const stateEl = document.querySelector("#state");
const resultsSection = document.querySelector("#resultsSection");
const bodyEl = document.querySelector("#resultsBody");
const bestEl = document.querySelector("#bestCards");
const diagEl = document.querySelector("#diagnosticList");
const providerBadge = document.querySelector("#providerBadge");
const retailerGrid = document.querySelector("#retailerGrid");
const retailerSummary = document.querySelector("#retailerSummary");

let retailerList = [];

boot();

async function boot(){
  try{
    const c=await fetch("/api/config").then(r=>r.json());
    retailerList=c.retailers||[];
    providerBadge.textContent=c.provider || "Direct retailer search";
    providerBadge.className="provider live";
    retailerGrid.innerHTML=retailerList.map(r=>`
      <label><input class="retailerCheck" type="checkbox" value="${esc(r.id)}" checked> ${esc(r.name)}</label>`).join("");
    updateRetailerSummary();
    retailerGrid.addEventListener("change",updateRetailerSummary);
  }catch{
    providerBadge.textContent="Server unavailable";providerBadge.className="provider off";
  }
  const last=localStorage.getItem("cigarScout:lastQuery");
  if(last) qEl.value=last;
}

function updateRetailerSummary(){
  const n=document.querySelectorAll(".retailerCheck:checked").length;
  retailerSummary.textContent=`Retailers (${n}/${retailerList.length} selected)`;
}

form.addEventListener("submit", async e=>{
  e.preventDefault();
  const q=qEl.value.trim();
  if(!q)return;
  localStorage.setItem("cigarScout:lastQuery",q);
  const pack=document.querySelector('input[name="pack"]:checked').value;
  const mode=document.querySelector('input[name="mode"]:checked').value;
  const selected=[...document.querySelectorAll(".retailerCheck:checked")].map(x=>x.value);
  await runSearch(q,pack,mode,selected);
});

async function runSearch(q,pack,mode,retailers){
  resultsSection.hidden=true;
  stateEl.style.display="block";
  stateEl.className="state";
  stateEl.innerHTML=`<div class="emptyIcon">⌕</div><h2>Searching retailers…</h2><p>Comparing product names, package sizes and visible prices.</p>`;
  const button=form.querySelector("button");
  button.disabled=true;button.textContent="Searching…";
  try{
    const u=new URL("/api/search",location.origin);
    u.searchParams.set("q",q);u.searchParams.set("pack",pack);u.searchParams.set("mode",mode);
    if(retailers.length && retailers.length!==retailerList.length) u.searchParams.set("retailers",retailers.join(","));
    const r=await fetch(u);
    const data=await r.json();
    if(!r.ok)throw new Error(data.setup ? `${data.error} ${data.setup}` : data.error || `HTTP ${r.status}`);
    render(data);
  }catch(err){
    stateEl.innerHTML=`<div class="errorBox"><strong>Search could not run.</strong><br>${esc(err.message||String(err))}</div>`;
  }finally{
    button.disabled=false;button.textContent="Search prices";
  }
}

function render(data){
  stateEl.style.display="none";resultsSection.hidden=false;
  document.querySelector("#resultsTitle").textContent=`${data.resultCount} offers for “${data.query}”`;
  document.querySelector("#stats").textContent=`${data.searchedRetailers} retailers • ${(data.ms/1000).toFixed(1)}s${data.cached?" • cached":""}`;

  if(!data.offers.length){
    bestEl.innerHTML="";
    bodyEl.innerHTML=`<tr><td colspan="7">No matching priced listings were found. Try “Include similar,” remove the dimensions, or enable more retailers.</td></tr>`;
  }else{
    const best=bestByPackage(data.offers);
    bestEl.innerHTML=best.map(([label,o])=>`
      <div class="bestCard">
        <div class="tag">${esc(label.toUpperCase())}</div>
        <div class="price">${money(o.price)}</div>
        <div>${esc(o.retailer)} · ${esc(o.packageLabel)}</div>
        <div class="meta">${o.unitPrice?`${money(o.unitPrice)} per cigar · `:""}${Math.round(o.matchScore*100)}% match</div>
      </div>`).join("");

    bodyEl.innerHTML=data.offers.map(o=>`
      <tr>
        <td><div class="retailer">${esc(o.retailer)}</div><div class="listing">${esc(o.title)}</div></td>
        <td><span class="pill">${esc(o.packageLabel)}</span></td>
        <td class="money">${money(o.price)}</td>
        <td class="unit">${o.unitPrice?money(o.unitPrice):"—"}</td>
        <td><span class="pill ${esc(o.availability)}">${stock(o.availability)}</span></td>
        <td class="match" title="${esc(o.matchReason||"")}">${Math.round(o.matchScore*100)}%<div class="bar"><i style="width:${Math.round(o.matchScore*100)}%"></i></div></td>
        <td><a class="visit" href="${escAttr(o.url)}" target="_blank" rel="noopener noreferrer nofollow">Listing ↗</a></td>
      </tr>`).join("");
  }

  diagEl.innerHTML=(data.statuses||[]).map(s=>`
    <div class="diag"><b>${esc(s.retailer)}</b><br>${esc(labelStatus(s.status))}${s.pages!=null?` · ${s.pages} page${s.pages===1?"":"s"}`:""}</div>`).join("");
}

function bestByPackage(offers){
  const groups=[
    ["Best single",offers.filter(o=>o.packageType==="single")],
    ["Best 5-pack",offers.filter(o=>o.packageType==="5pack")],
    ["Best box",offers.filter(o=>o.packageType==="box")]
  ];
  return groups.map(([label,arr])=>[label,[...arr].sort((a,b)=>a.price-b.price)[0]]).filter(x=>x[1]).slice(0,3);
}

function labelStatus(s){return ({ok:"prices found",no_price_found:"product pages found, price unclear",no_search_results:"no matching listing found",blocked:"blocked automated check",rate_limited:"temporarily rate limited",timeout:"timed out",search_error:"search unavailable"})[s]||s}
function stock(x){return x==="in_stock"?"In stock":x==="out_of_stock"?"Out of stock":"Unknown"}
function money(n){return Number.isFinite(Number(n))?new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(Number(n)):"—"}
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function escAttr(s){return esc(s)}
