# Free deployment

This build does not need a search API key.

## Render

1. Create a free GitHub account if you do not have one.
2. Create a new GitHub repository named `cigar-price-scout`.
3. Upload the contents of this project folder to that repository.
4. Create a Render account.
5. Choose **New → Blueprint** and connect the repository, or create a **Web Service** from the repository.
6. Render reads `render.yaml`; the start command is `node server.js`.
7. Deploy and open the public URL Render gives you.

No payment/search-API key is required by the application itself.

## What to expect

A search contacts multiple cigar retailers directly. Some stores may respond slowly or refuse automated requests. The diagnostics section shows which retailers returned prices, no match, a timeout, or a block.
