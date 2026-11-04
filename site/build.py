#!/usr/bin/env python3
"""Build site/index.html from the landing source (body + styles) with the full production head.

Usage: python3 site/build.py [path/to/tenfold-landing.html]
SITE_URL is the canonical origin; change it to https://tenfold.trade once the domain is live.
"""
import hashlib, base64, json, os, sys

SITE_URL = os.environ.get("TENFOLD_SITE_URL", "https://tenfold-musmus9s-projects.vercel.app")
TITLE = "Tenfold: a market-making desk for your Solana token"
DESCRIPTION = "Give it a mandate, fund a wallet it can never withdraw from, and Tenfold defends your price, distributes your supply into real buyers and reports to you, on its own."
OG_TITLE = "Tenfold: give it a mandate, it runs the market"

here = os.path.dirname(os.path.abspath(__file__))
src_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, "tenfold-landing.html")
src = open(src_path, encoding="utf-8").read()

i = src.index("</style>") + len("</style>")
# the source head carries the artifact's own title and metas; only its font links and styles are kept
links = src[src.index('<link rel="preconnect"'):i]
body = src[i:]

head = f'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{TITLE}</title>
<meta name="description" content="{DESCRIPTION}">
<link rel="canonical" href="{SITE_URL}/">
<meta name="robots" content="index, follow, max-image-preview:large">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#F4F2EC" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#101311" media="(prefers-color-scheme: dark)">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Tenfold">
<meta property="og:url" content="{SITE_URL}/">
<meta property="og:title" content="{OG_TITLE}">
<meta property="og:description" content="{DESCRIPTION}">
<meta property="og:image" content="{SITE_URL}/assets/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Tenfold: give it a mandate, it runs the market. A market-making desk for Solana founders.">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{OG_TITLE}">
<meta name="twitter:description" content="{DESCRIPTION}">
<meta name="twitter:image" content="{SITE_URL}/assets/og-image.png">
<script type="application/ld+json">{json.dumps({
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    "name": "Tenfold",
    "applicationCategory": "FinanceApplication",
    "operatingSystem": "Telegram",
    "url": SITE_URL + "/",
    "description": DESCRIPTION,
    "offers": {"@type": "Offer", "price": "0", "priceCurrency": "USD", "description": "No setup or monthly fee. 0.5% of traded volume and 2% at cashout."},
}, separators=(",", ":"))}</script>
'''

html = head + links + "\n</head>\n<body>" + body + "\n</body>\n</html>\n"
out = os.path.join(here, "index.html")
open(out, "w", encoding="utf-8").write(html)

# Content-Security-Policy: the inline script is allowed by hash, nothing else runs.
scripts = []
start = 0
while True:
    a = html.find("<script>", start)
    if a < 0:
        break
    b = html.find("</script>", a)
    scripts.append(html[a + len("<script>"):b])
    start = b
hashes = " ".join("'sha256-" + base64.b64encode(hashlib.sha256(x.encode("utf-8")).digest()).decode() + "'" for x in scripts)
csp = (
    "default-src 'self'; "
    f"script-src {hashes}; "
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
    "font-src https://fonts.gstatic.com; "
    "img-src 'self' data:; "
    "connect-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'; upgrade-insecure-requests"
)
vercel = {
    "cleanUrls": True,
    "trailingSlash": False,
    "headers": [
        {"source": "/(.*)", "headers": [
            {"key": "Content-Security-Policy", "value": csp},
            {"key": "X-Content-Type-Options", "value": "nosniff"},
            {"key": "X-Frame-Options", "value": "DENY"},
            {"key": "Referrer-Policy", "value": "strict-origin-when-cross-origin"},
            {"key": "Permissions-Policy", "value": "camera=(), microphone=(), geolocation=(), payment=(), usb=()"},
            {"key": "Strict-Transport-Security", "value": "max-age=63072000; includeSubDomains; preload"},
            {"key": "Cross-Origin-Opener-Policy", "value": "same-origin"},
        ]},
        {"source": "/assets/(.*)", "headers": [{"key": "Cache-Control", "value": "public, max-age=604800, stale-while-revalidate=86400"}]},
        {"source": "/favicon.ico", "headers": [{"key": "Cache-Control", "value": "public, max-age=604800"}]},
    ],
}
open(os.path.join(here, "vercel.json"), "w").write(json.dumps(vercel, indent=2) + "\n")
open(os.path.join(here, "site.webmanifest"), "w").write(json.dumps({
    "name": "Tenfold", "short_name": "Tenfold", "description": DESCRIPTION,
    "start_url": "/", "display": "browser", "background_color": "#F4F2EC", "theme_color": "#0F6B47",
    "icons": [{"src": "/assets/favicon-192.png", "sizes": "192x192", "type": "image/png"}, {"src": "/assets/icon-512.png", "sizes": "512x512", "type": "image/png"}],
}, indent=2) + "\n")
open(os.path.join(here, "robots.txt"), "w").write(f"User-agent: *\nAllow: /\nSitemap: {SITE_URL}/sitemap.xml\n")
open(os.path.join(here, "sitemap.xml"), "w").write(f'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>{SITE_URL}/</loc></url></urlset>\n')
print(f"index.html {len(html)} bytes, {len(scripts)} inline script(s) hashed, site url {SITE_URL}")
