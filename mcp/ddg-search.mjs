#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// MCP SERVER — Web Search Multi-Mesin (Task 29; upgrade Task 30).
//
// Protokol: Model Context Protocol (JSON-RPC 2.0, stdio newline-delimited).
// Tools yang diekspos:
//   • web_search  { query: string, max_results?: number }
//       → cari web dengan RANTAI FALLBACK: provider ber-kunci (env,
//         opsional) → DuckDuckGo html/lite → Brave → Bing → DDG API.
//         Mesin pertama yang mengembalikan hasil menang; mesin yang
//         gagal diberi cooldown 10 menit.
//   • read_page   { url: string, max_length?: number }
//       → ambil isi halaman sebagai teks polos (cap 20.000 karakter).
//
// Cara pakai (klien MCP apa pun, mis. Claude Desktop):
//   node /path/ke/aula-03/mcp/ddg-search.mjs
//
// Contoh konfigurasi Claude Desktop (claude_desktop_config.json):
//   {
//     "mcpServers": {
//       "ddg-search": {
//         "command": "node",
//         "args": ["/path/ke/aula-03/mcp/ddg-search.mjs"]
//       }
//     }
//   }
//
// Env:
//   DDG_BASE_URL            — override endpoint DDG (testing/mock).
//   WEB_SEARCH_ENGINES      — pin daftar mesin (mis. "ddg-html,ddg-lite").
//   WEB_SEARCH_TIMEOUT_MS   — batas waktu per mesin (default 6000).
//   WEB_SEARCH_SERPER_KEY / WEB_SEARCH_BRAVE_KEY / WEB_SEARCH_TAVILY_KEY /
//   WEB_SEARCH_SEARX_URL    — provider ber-kunci opsional (produksi).
//
// Nol dependensi: hanya API standar Node ≥ 18 (fetch, readline).
// Logika pencarian dibagikan dengan aplikasi lewat src/lib/ddg-core.mjs.
// ─────────────────────────────────────────────────────────────────────

import { createInterface } from "node:readline";
import {
  webSearchMulti,
  readPageText,
  ENGINE_LABELS,
} from "../src/lib/ddg-core.mjs";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "ddg-search", version: "1.0.0" };

const TOOLS = [
  {
    name: "web_search",
    description:
      "Cari di web dengan rantai fallback multi-mesin (provider ber-kunci " +
      "opsional via env → DuckDuckGo → Brave → Bing; tanpa API key). " +
      "Mengembalikan daftar hasil: judul, URL, dan ringkasan. Cocok untuk " +
      "pertanyaan berita, hal terkini, atau topik di luar pengetahuan model.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Kata kunci pencarian" },
        max_results: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          description: "Jumlah hasil maksimum (default 6)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "read_page",
    description:
      "Ambil isi sebuah halaman web sebagai teks polos (maks 20.000 karakter). " +
      "Pakai setelah web_search untuk membaca halaman menarik lebih lanjut.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL halaman (http/https)" },
        max_length: {
          type: "integer",
          minimum: 500,
          maximum: 20000,
          description: "Batas panjang teks (default 20000)",
        },
      },
      required: ["url"],
    },
  },
];

// ── Error MCP standar ─────────────────────────────────────────────────

class McpError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ── Handlers tool ─────────────────────────────────────────────────────

async function callWebSearch(args) {
  if (typeof args?.query !== "string" || !args.query.trim()) {
    throw new McpError(-32602, "Parameter 'query' wajib berupa string tak kosong.");
  }
  const max = Number.isInteger(args.max_results) ? args.max_results : 6;
  const { results, engine, errors } = await webSearchMulti(args.query, { max });
  if (!results.length) {
    const tried = errors.map(([id, msg]) => `${id}: ${msg}`).join("; ");
    return {
      content: [{
        type: "text",
        text:
          `Pencarian gagal — semua mesin penelusuran tidak dapat dihubungi (${tried}). ` +
          "Kalau ini terus terjadi, pasang provider ber-API-key via env " +
          "(WEB_SEARCH_SERPER_KEY / WEB_SEARCH_BRAVE_KEY / WEB_SEARCH_TAVILY_KEY / WEB_SEARCH_SEARX_URL).",
      }],
      isError: true,
    };
  }
  const label = ENGINE_LABELS[engine] ?? engine;
  const lines = results.map(
    (r, i) => `[${i + 1}] ${r.title}\n    ${r.url}${r.snippet ? `\n    ${r.snippet}` : ""}`
  );
  return {
    content: [
      {
        type: "text",
        text: `Hasil pencarian (${label}) untuk "${args.query}":\n\n${lines.join("\n\n")}`,
      },
    ],
  };
}

async function callReadPage(args) {
  if (typeof args?.url !== "string" || !/^https?:\/\//i.test(args.url)) {
    throw new McpError(-32602, "Parameter 'url' wajib URL http/https yang valid.");
  }
  try {
    const text = await readPageText(args.url, {
      maxLength: Number.isInteger(args.max_length) ? args.max_length : 20_000,
    });
    return { content: [{ type: "text", text }] };
  } catch (e) {
    return {
      content: [{ type: "text", text: `Gagal membaca halaman: ${e?.message ?? e}` }],
      isError: true,
    };
  }
}

// ── Dispatch JSON-RPC ─────────────────────────────────────────────────

async function dispatch(id, method, params) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (name === "web_search") return callWebSearch(args);
      if (name === "read_page") return callReadPage(args);
      throw new McpError(-32602, `Tool tidak dikenal: ${name}`);
    }
    default:
      throw new McpError(-32601, `Method tidak dikenal: ${method}`);
  }
}

// ── Loop stdio ────────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, terminal: false });

// Jumlah permintaan yang sedang diproses — stdin ditutup lebih awal
// (klien pipes sekaligus lalu EOF) tidak boleh memotong respons yang
// belum selesai ditulis.
let pending = 0;
let closed = false;
function maybeExit() {
  if (closed && pending <= 0) process.exit(0);
}

rl.on("line", (line) => {
  const raw = line.trim();
  if (!raw) return;
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    // JSON rusak → balas error parse (id null) lalu lanjut.
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      }) + "\n"
    );
    return;
  }

  const { jsonrpc, id, method, params } = msg ?? {};

  // Notifikasi (tanpa id) — termasuk "notifications/initialized" — tidak
  // dibalas sesuai spesifikasi MCP.
  if (id === undefined || id === null) {
    if (method === "notifications/initialized") {
      process.stderr.write(`[ddg-search] klien terinisialisasi — ${TOOLS.length} tool siap\n`);
    }
    return;
  }
  if (jsonrpc !== "2.0" || typeof method !== "string") {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: id ?? null,
        error: { code: -32600, message: "Invalid Request" },
      }) + "\n"
    );
    return;
  }

  dispatch(id, method, params)
    .then((result) => {
      process.stdout.write(
        JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"
      );
    })
    .catch((e) => {
      const err =
        e instanceof McpError
          ? { code: e.code, message: e.message }
          : { code: -32603, message: `Internal error: ${e?.message ?? e}` };
      process.stdout.write(
        JSON.stringify({ jsonrpc: "2.0", id, error: err }) + "\n"
      );
    })
    .finally(() => {
      pending--;
      maybeExit();
    });
  pending++;
});

rl.on("close", () => {
  closed = true;
  maybeExit();
});

// Kirim log singkat ke stderr (stdout = kanal protokol, HARUS bersih).
process.stderr.write(
  `[ddg-search] MCP server berjalan (stdio) — tools: web_search, read_page\n`
);
