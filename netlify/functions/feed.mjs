// Instagram Grid Preview for Notion, by Made Interactive.
//
// Reads your Content, Profile and Highlights databases from Notion and returns
// only what the Instagram-style preview needs. It finds the databases by their
// fields, so there are no IDs to copy.
//
// Settings (Netlify > Project configuration > Environment variables):
//   NOTION_TOKEN  required  Your Notion connection key ("Internal Integration Secret" / API token).
//   ACCESS_CODE   optional  Makes your preview link private and turns on the Approve button.
//                           Your link then ends in ?code=YOUR_CODE.
//
// The Notion key stays on Netlify and never reaches the browser.

import { timingSafeEqual } from "node:crypto";

const API = "https://api.notion.com/v1";
const NEW_VERSION = "2025-09-03";   // data-source API
const OLD_VERSION = "2022-06-28";   // fallback for older workspaces
const MAX_PINNED = 3;
const MAX_POSTS = 24;
const MAX_HIGHLIGHTS = 5;
const APPROVABLE = ["Ready for review", "Changes requested", "Approved"];

// Made Interactive's Gumroad product ID (Gumroad > Products > your product > Content/Settings).
// While this is empty, the license check is switched off.
const GUMROAD_PRODUCT_ID = "xBgKQb0wyGsXWJHX1ddHWA==";

// ---------- Routes ----------

export default async (req) => {
  const url = new URL(req.url);
  const token = (process.env.NOTION_TOKEN || "").trim();
  const accessCode = (process.env.ACCESS_CODE || "").trim();

  if (url.pathname.endsWith("/setup")) return setupCheck(token, accessCode);

  if (!token) return json({ error: "missing_token", message: "This preview isn't connected to Notion yet. Open /setup on this site to finish setting it up." }, 500);

  const lic = await license();
  if (!lic.ok) return json({ error: "license", message: lic.message }, 402);

  const codeOk = !!accessCode && sameText(url.searchParams.get("code") || "", accessCode);
  if (accessCode && !codeOk) {
    return json({ error: "bad_code", message: "This preview link is incomplete or out of date. Ask the account owner for the current link." }, 403);
  }

  if (req.method === "POST") return approve(req, token, codeOk);
  if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);

  try {
    const s = await sources(token);
    if (!s.content) return json({ error: "not_set_up", message: "No Content database found. Open /setup on this site to see what's missing." }, 503);

    const [postRows, profileRows, highlightRows] = await Promise.all([
      query(token, s.content, {
        filter: { property: "Show on grid", checkbox: { equals: true } },
        sorts: [{ property: "Publish date", direction: "descending" }],
        page_size: 100,
      }),
      s.profile ? query(token, s.profile, { page_size: 1 }) : [],
      s.highlights ? query(token, s.highlights, { sorts: [{ property: "Order", direction: "ascending" }], page_size: MAX_HIGHLIGHTS }) : [],
    ]);

    const profile = toProfile(profileRows[0]);
    return json({
      client: { name: profile.name || "Your brand", accent: profile.accent, settingsUrl: profileRows[0]?.url || null },
      profile,
      highlights: highlightRows.map(toHighlight).filter((h) => h.name || h.cover).slice(0, MAX_HIGHLIGHTS),
      posts: orderPosts(postRows.map(toPost)),
      // The Approve button works only when the link carries the access code.
      review: codeOk,
      updated: new Date().toISOString(),
    });
  } catch (err) {
    forgetSources();
    return json(notionProblem(err), err.status === 401 ? 401 : err.status === 403 || err.status === 404 ? 403 : 502);
  }
};

export const config = { path: ["/api/feed", "/api/setup"] };

function notionProblem(err) {
  if (err.status === 401) return { error: "bad_token", message: "Notion didn't accept the key. Copy the API token again from your Notion connection and update NOTION_TOKEN in Netlify." };
  if (err.status === 403 || err.status === 404) return { error: "no_access", message: "The Notion connection can't see your template. In Notion, open your template page > ••• > Connections and add your connection." };
  return { error: "notion_error", message: "Notion didn't respond as expected. Press Reload in a moment." };
}

// ---------- Setup check (no private data in the answer) ----------

async function setupCheck(token, accessCode) {
  const lic = await license(true);
  const report = {
    license: lic.skipped ? "off" : lic.unverified ? "unverified" : lic.ok ? "ok" : "bad",
    licenseMessage: lic.ok ? null : lic.message,
    token: !!token,
    accessCode: !!accessCode,
    content: null, profile: null, highlights: null,
    problems: [],
  };
  if (!token) {
    report.problems.push({ step: "token", message: "NOTION_TOKEN is empty. In Netlify, open Project configuration > Environment variables, add NOTION_TOKEN with your Notion key, then redeploy." });
    return json(report);
  }
  try {
    forgetSources();
    const s = await sources(token);
    const describe = async (src) => {
      if (!src) return null;
      let rows = null;
      try { rows = (await query(token, src, { page_size: 100 }, 1)).length; } catch { /* count is optional */ }
      return { name: src.title || "Untitled", rows };
    };
    [report.content, report.profile, report.highlights] = await Promise.all([describe(s.content), describe(s.profile), describe(s.highlights)]);
    for (const kind of ["content", "profile", "highlights"]) {
      if (s.duplicates[kind] > 1) {
        report.problems.push({ step: kind, message: `Found ${s.duplicates[kind]} ${LABEL[kind]} databases. Connect your Notion connection to one template page only (one preview per Instagram account).` });
      } else if (!s[kind] && kind !== "highlights") {
        report.problems.push({ step: kind, message: `No ${LABEL[kind]} database found. In Notion, open your template page > ••• > Connections and add your connection.` });
      }
    }
  } catch (err) {
    report.problems.push({ step: "notion", message: notionProblem(err).message });
  }
  return json(report);
}

const LABEL = { content: "Content", profile: "Profile", highlights: "Highlights" };

// ---------- License (Gumroad) ----------
// Checks the buyer's LICENSE_KEY with Gumroad. A refunded, charged-back or disabled key stops the preview.
// If Gumroad itself can't be reached, the preview keeps working rather than locking out a paying customer.

let licenseCache = null; // { at, value }
const LICENSE_OK_MS = 12 * 60 * 60 * 1000;
const LICENSE_BAD_MS = 5 * 60 * 1000;

async function license(fresh = false) {
  if (!GUMROAD_PRODUCT_ID) return { ok: true, skipped: true };
  const key = (process.env.LICENSE_KEY || "").trim();
  if (!key) return { ok: false, message: "This preview needs a license key. In Netlify, add LICENSE_KEY with the key from your purchase receipt, then redeploy." };
  if (!fresh && licenseCache && Date.now() - licenseCache.at < (licenseCache.value.ok ? LICENSE_OK_MS : LICENSE_BAD_MS)) return licenseCache.value;

  let value;
  try {
    const res = await fetch("https://api.gumroad.com/v2/licenses/verify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ product_id: GUMROAD_PRODUCT_ID, license_key: key, increment_uses_count: "false" }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status >= 500 && !data.message) throw new Error("gumroad_unavailable");
    const p = data.purchase || {};
    if (!data.success) {
      value = { ok: false, message: /disabled/i.test(data.message || "") ? "This license key has been disabled. Contact Made Interactive if you think this is a mistake." : "This license key isn't valid. Copy it again from your purchase receipt and update LICENSE_KEY in Netlify." };
    } else if (p.refunded || p.chargebacked || p.disputed) {
      value = { ok: false, message: "This license is no longer active because the purchase was refunded or disputed." };
    } else {
      value = { ok: true };
    }
  } catch {
    // Gumroad unreachable: keep the last answer if there is one, otherwise allow.
    return licenseCache?.value || { ok: true, unverified: true };
  }
  licenseCache = { at: Date.now(), value };
  return value;
}

// ---------- Approve ----------
// The only change the preview can make in Notion: setting a post's Status to "Approved".

async function approve(req, token, codeOk) {
  if (!codeOk) return json({ error: "review_off", message: "Approvals are off. Set ACCESS_CODE in Netlify to turn them on." }, 403);

  let body;
  try { body = await req.json(); } catch { return json({ error: "bad_request", message: "Something went wrong. Try again." }, 400); }
  const pageId = String(body?.pageId || "").replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(pageId) || body?.action !== "approve") {
    return json({ error: "bad_request", message: "Something went wrong. Try again." }, 400);
  }

  try {
    const s = await sources(token);
    const page = await notion(token, `/pages/${pageId}`);
    if (!belongsTo(page, s.content) || page.in_trash || page.archived) {
      return json({ error: "not_found", message: "This post isn't part of this preview." }, 404);
    }
    const statusProp = page.properties?.Status;
    const current = statusProp?.status?.name || statusProp?.select?.name || null;
    if (!APPROVABLE.includes(current)) {
      return json({ error: "not_reviewable", status: current, message: `This post is ${current ? `"${current}"` : "not ready yet"}, so it can't be approved from the preview.` }, 409);
    }
    if (current === "Approved") return json({ ok: true, status: "Approved" });

    const value = statusProp?.type === "select" ? { select: { name: "Approved" } } : { status: { name: "Approved" } };
    await notion(token, `/pages/${pageId}`, { method: "PATCH", version: OLD_VERSION, body: { properties: { Status: value } } });
    return json({ ok: true, status: "Approved" });
  } catch (err) {
    if (err.status === 403 || err.code === "restricted_resource") {
      return json({ error: "no_permission", message: "The preview isn't allowed to approve posts yet. In your Notion connection's settings, turn on Update content." }, 403);
    }
    if (err.status === 404) return json({ error: "not_found", message: "This post couldn't be found. Press Reload and try again." }, 404);
    return json({ error: "notion_error", message: "Notion didn't respond as expected. Try again in a moment." }, 502);
  }
}

const norm = (s) => String(s || "").replace(/-/g, "").toLowerCase();
function belongsTo(page, content) {
  if (!content) return false;
  const p = page.parent || {};
  return (content.kind === "data_source" && norm(p.data_source_id) === norm(content.id))
    || norm(p.database_id) === norm(content.databaseId || (content.kind === "database" ? content.id : ""));
}

function sameText(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// ---------- Finding the template's databases ----------
// Each database is recognised by its fields, so renaming the databases is fine.

const has = (props, name, ...types) => !!props?.[name] && (!types.length || types.includes(props[name].type));
const KINDS = {
  content: (p) => has(p, "Publish date", "date") && has(p, "Show on grid", "checkbox") && (has(p, "Content Slides", "files") || has(p, "Cover", "files")),
  profile: (p) => has(p, "Display name", "title") && has(p, "Handle"),
  highlights: (p) => has(p, "Order", "number") && (has(p, "Stories", "files") || has(p, "Cover", "files")) && !has(p, "Publish date"),
};

let cached = null; // { at, value }
const CACHE_MS = 5 * 60 * 1000;
function forgetSources() { cached = null; }

async function sources(token) {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  let found;
  try { found = await searchAll(token, NEW_VERSION, "data_source"); }
  catch (e) {
    if (e.status === 401) throw e;
    found = await searchAll(token, OLD_VERSION, "database");
  }
  const value = { duplicates: {} };
  for (const kind of Object.keys(KINDS)) {
    const matches = found.filter((s) => KINDS[kind](s.properties));
    value.duplicates[kind] = matches.length;
    value[kind] = matches.length === 1 ? matches[0] : null;   // never guess between two
  }
  cached = { at: Date.now(), value };
  return value;
}

async function searchAll(token, version, objectType) {
  const out = [];
  let cursor;
  for (let i = 0; i < 10; i++) {
    const res = await notion(token, "/search", {
      method: "POST", version,
      body: { filter: { property: "object", value: objectType }, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
    });
    for (const r of res.results || []) {
      if (r.in_trash || r.archived) continue;
      out.push({
        kind: objectType,
        id: r.id,
        databaseId: objectType === "database" ? r.id : r.parent?.database_id || r.database_parent?.database_id || null,
        title: (r.title || []).map((t) => t.plain_text).join("") || null,
        properties: r.properties || {},
      });
    }
    if (!res.has_more) break;
    cursor = res.next_cursor;
  }
  return out;
}

// ---------- Notion calls ----------

async function notion(token, path, { method = "GET", body, version = NEW_VERSION } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Notion-Version": version, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.message || `Notion ${res.status}`);
    e.status = res.status;
    e.code = data.code;
    throw e;
  }
  return data;
}

async function query(token, src, body, maxPages = 2) {
  const run = (cursor) => {
    const b = { ...body, ...(cursor ? { start_cursor: cursor } : {}) };
    return src.kind === "data_source"
      ? notion(token, `/data_sources/${src.id}/query`, { method: "POST", body: b })
      : notion(token, `/databases/${src.id}/query`, { method: "POST", body: b, version: OLD_VERSION });
  };
  const rows = [];
  let cursor;
  let pages = 0;
  do {
    const page = await run(cursor);
    rows.push(...(page.results || []));
    cursor = page.has_more ? page.next_cursor : null;
    pages++;
  } while (cursor && pages < maxPages);
  return rows;
}

// ---------- Property readers ----------

const prop = (page, name) => page?.properties?.[name];
const text = (p) => (p?.title || p?.rich_text || []).map((t) => t.plain_text).join("");
const fileUrl = (f) => (f?.type === "external" ? f.external?.url : f?.file?.url) || null;
const firstFile = (p) => fileUrl(p?.files?.[0]);

// Every image or video in a Files property, in the order it was placed in Notion.
const VIDEO = /\.(mp4|mov|m4v|webm)$/i;
const SKIP = /\.(avi|mkv|mp3|wav|m4a|pdf|zip|rar|psd|ai|indd|fig|sketch|docx?|xlsx?|pptx?|txt)$/i;
function media(p) {
  return (p?.files || [])
    .map((f) => {
      const url = fileUrl(f);
      const name = (f.name || "").trim();
      const path = url ? url.split("?")[0] : "";
      return { url, name, type: VIDEO.test(name) || VIDEO.test(path) ? "video" : "image", skip: SKIP.test(name) || SKIP.test(path) };
    })
    .filter((m) => m.url && !m.skip);
}
const images = (p) => media(p).filter((m) => m.type === "image");

// Slides in order, skipping repeats (the same file name twice).
export function slidesFor(prop) {
  const seen = new Set();
  const out = [];
  for (const m of media(prop)) {
    const key = (m.name || m.url.split("?")[0]).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url: m.url, type: m.type });
  }
  return out;
}

function toPost(page) {
  const format = prop(page, "Format")?.select?.name || null;
  const contentSlides = prop(page, "Content Slides") || prop(page, "Cover");
  let slides = slidesFor(contentSlides);
  // A Reel plays only its video; an image in Content Slides becomes its grid cover.
  if (format === "Reel" && slides.some((s) => s.type === "video")) slides = slides.filter((s) => s.type === "video").slice(0, 1);
  return {
    id: page.id,
    url: page.url,
    title: text(prop(page, "Name")),
    date: prop(page, "Publish date")?.date?.start || null,
    status: prop(page, "Status")?.status?.name || prop(page, "Status")?.select?.name || null,
    format,
    campaign: prop(page, "Campaign")?.select?.name || null,
    caption: text(prop(page, "Caption")),
    hashtags: text(prop(page, "Hashtags")),
    cover: images(contentSlides)[0]?.url || slides.find((s) => s.type === "image")?.url || null,
    coverVideo: slides.find((s) => s.type === "video")?.url || null,
    slides,
    pinned: prop(page, "Pinned")?.checkbox === true,
  };
}

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;
function toProfile(page) {
  if (!page) return { name: "", handle: "", category: "", bio: "", link: "", photo: null, accent: null };
  const accent = text(prop(page, "Accent color")).trim();
  return {
    name: text(prop(page, "Display name")),
    handle: text(prop(page, "Handle")).replace(/^@/, "").trim(),
    category: text(prop(page, "Category")),
    bio: text(prop(page, "Bio")),
    link: prop(page, "Link")?.url || "",
    photo: firstFile(prop(page, "Profile photo")),
    accent: HEX.test(accent) ? (accent.startsWith("#") ? accent : "#" + accent) : null,
  };
}

function toHighlight(page) {
  return { name: text(prop(page, "Name")), cover: firstFile(prop(page, "Cover")), stories: slidesFor(prop(page, "Stories")) };
}

// Pinned posts first (newest pinned first, max 3), then everything else newest first.
export function orderPosts(posts) {
  const byDate = (a, b) => (b.date || "").localeCompare(a.date || "");
  const pinned = posts.filter((p) => p.pinned).sort(byDate).slice(0, MAX_PINNED);
  const pinnedIds = new Set(pinned.map((p) => p.id));
  const rest = posts.filter((p) => !pinnedIds.has(p.id)).sort(byDate);
  return [...pinned, ...rest.map((p) => ({ ...p, pinned: false }))].slice(0, MAX_POSTS);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
