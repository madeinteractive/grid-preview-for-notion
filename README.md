# Grid Preview for Notion

An Instagram-style feed preview for your Notion content calendar: profile, highlights, pinned posts, carousels, videos and an optional client approval button.

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/madeinteractive/grid-preview-for-notion)

## What you need

- The Instagram Grid Preview Notion template (included with your purchase), duplicated into your Notion
- A free Notion connection key
- Free GitHub and Netlify accounts

## Setup in short

1. Duplicate the Notion template into your workspace.
2. Create a Notion connection (Settings → Connections → Develop or manage integrations → New), with **Read content** on. Turn on **Update content** too if you want the Approve button.
3. Connect it to your template page: ••• → Connections → add your connection.
4. Click **Deploy to Netlify** above. Paste your license key as `LICENSE_KEY` and your Notion key as `NOTION_TOKEN`. `ACCESS_CODE` is optional.
5. Open `https://YOUR-SITE.netlify.app/setup` to check everything, then copy your link.
6. In Notion, type `/embed` on the preview page and paste your link.

The full guide with screenshots comes with your purchase.

## Settings

| Setting | Needed | What it does |
|---|---|---|
| `LICENSE_KEY` | Yes | The license key from your Gumroad receipt. One key per purchase. |
| `NOTION_TOKEN` | Yes | Your Notion connection key. Stays on Netlify, never shown to visitors. |
| `ACCESS_CODE` | No | A private code you choose. Your link then ends in `?code=YOUR_CODE`, and clients can approve posts. |

One site shows one Instagram account. For more accounts (for example, one per client), duplicate the template again and deploy another site.

## Updating

When a new version comes out: in your GitHub copy, replace the `public` and `netlify` folders with the new ones (one commit), and Netlify republishes by itself.

© Made Interactive. This is not open-source software. Use requires a purchased license; see [LICENSE.md](LICENSE.md). You may use it for your own accounts and your clients' accounts, but you may not resell, share or redistribute it.

Not affiliated with, endorsed by or sponsored by Instagram or Meta. Instagram is a trademark of Instagram, LLC.
