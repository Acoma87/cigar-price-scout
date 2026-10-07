# Cigar Price Scout — Free Direct Search Build

This version requires **no Brave, Google, Serper, or other paid search API**.

It searches the configured cigar retailers directly. The current retailer list contains **40 stores**.

## How it works

1. You type a cigar name.
2. The server opens each retailer's own search/catalog endpoint.
3. It detects common ecommerce search styles (Shopify, BigCommerce, Magento, WooCommerce, and several generic search patterns).
4. It scores likely product links by cigar name and dimensions.
5. It opens the best matching product pages.
6. It extracts structured Product/Offer pricing and visible package pricing.
7. It normalizes results into single, 5-pack, box, stock status, and price per cigar when package count is known.

Successful search patterns are cached per retailer so later searches do not have to probe every pattern again.

## Cost

There is no paid search API requirement. You can run it locally or on a free-compatible Node host.

## Run locally

Node.js 20+ is the only requirement.

```bash
node server.js
```

Then open `http://localhost:3000`.

## Deploy

The repository includes `render.yaml` and `railway.json`. For Render, connect the repository and deploy; no API-key environment variable is required.

## Limitations

Some cigar stores intentionally block automated traffic, require browser JavaScript, use CAPTCHA/age-gate systems, or do not expose enough price information in their HTML. This application does **not** bypass those controls. Such stores are shown as blocked/unavailable instead of producing a fake price.

Retailer sites change over time, so retailer-specific adapters can be added to improve coverage for important stores.

Shipping, tax, coupons, club pricing, and login-only discounts are not yet included.
