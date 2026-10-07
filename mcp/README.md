# MCP Server — DuckDuckGo Web Search

Server [Model Context Protocol](https://modelcontextprotocol.io) untuk pencarian web dengan **DuckDuckGo** — tanpa API key, tanpa dependensi (hanya Node ≥ 18).

## Tools

| Tool | Input | Keterangan |
|------|-------|------------|
| `web_search` | `query` (wajib), `max_results?` (1–10, default 6) | Cari web via DuckDuckGo; hasil: judul, URL, ringkasan. |
| `read_page` | `url` (wajib), `max_length?` (500–20000) | Ambil isi halaman sebagai teks polos. |

## Menjalankan

```bash
node mcp/ddg-search.mjs
```

Berkomunikasi lewat **stdio** dengan JSON-RPC 2.0 (satu pesan per baris). Protocol version: `2024-11-05`.

## Pasang di Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ddg-search": {
      "command": "node",
      "args": ["/path/ke/aula-03/mcp/ddg-search.mjs"]
    }
  }
}
```

## Pasang di klien MCP lain (Cursor, dsb.)

Sama — cukup arahkan command ke `node mcp/ddg-search.mjs`.

## Variabel lingkungan

- `DDG_BASE_URL` — override endpoint DuckDuckGo (default `https://html.duckduckgo.com`); berguna untuk proxy internal atau pengujian.

## Sumber daya bersama

Logika pencarian dipakai bersama aplikasi Aula (`src/lib/ddg-core.mjs` → `src/lib/ddg-search.ts`) sehingga Teman AI punya fitur pencarian web (`/cari …` atau deteksi otomatis) dengan implementasi yang sama.

## Contoh sesi JSON-RPC

```jsonc
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"contoh","version":"1.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"web_search","arguments":{"query":"transformer attention","max_results":3}}}
```
