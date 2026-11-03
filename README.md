# FileN-MCP Server

Unofficial [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for [Filen](https://filen.io) (filen.io), built on the official [`@filen/sdk`](https://www.npmjs.com/package/@filen/sdk) TypeScript SDK.

> **Unofficial disclaimer:** This project is **not** affiliated with, endorsed by, or supported by Filen Cloud Dienste UG. It is a community effort and comes with no warranty. **Use at your own risk.** Filen itself has no official MCP server (yet) — if one is released, prefer the official one.

The server speaks MCP over **stdio only** (no network listener) and exposes your Filen cloud drive as tools to MCP clients such as Claude Desktop or Cursor.

## Tools

All cloud paths are absolute, starting at `/` (the root of your Filen drive).

| Tool | Description | Read-only |
| --- | --- | --- |
| `list_directory` | List entries of a directory (`path`, optional `recursive`) | yes |
| `stat` | Metadata of a file/folder: `type`, `uuid`, `size`, `mtimeMs`, `birthtimeMs` (`path`) | yes |
| `read_file` | Read a file as UTF-8 text (`path`); refuses non-files and files > 5 MB (use `download_file` for those) | yes |
| `search_files` | Case-insensitive substring search over paths (`query`, optional `path`, default `/`) | yes |
| `write_file` | Write UTF-8 text to a cloud file, creating/overwriting it (`path`, `content`) | no |
| `upload_file` | Upload a local file/directory to the cloud (`source` local path, `path` cloud destination) | no |
| `download_file` | Download a cloud file/directory to a local path (`path`, `destination`) | yes |
| `create_folder` | Create a folder, including intermediate directories (`path`) | no |
| `delete_item` | Delete a file/folder (`path`, `permanent=false` → trash; `permanent=true` → permanent) | no |

Tool errors are returned as MCP tool results with `isError: true` and a text message starting with `Error:`.

## Requirements

- Node.js >= 20
- A Filen account and either an **API key** or your **email/password** (see below)

## Setup

```sh
git clone https://github.com/Mantic0re1337/FileN-MCP.git
cd FileN-MCP
npm install
npm run build
```

Run it directly:

```sh
FILEN_API_KEY="your-api-key" npm start
```

Or inspect it with the MCP Inspector:

```sh
FILEN_API_KEY="your-api-key" npm run inspect
```

## Credentials (environment variables only)

The server never hardcodes credentials. Provide them via environment variables:

| Variable | Purpose |
| --- | --- |
| `FILEN_API_KEY` | Your Filen API key. Preferred option — no 2FA needed on subsequent calls. |
| `FILEN_EMAIL` + `FILEN_PASSWORD` | Account login instead of an API key. |
| `FILEN_2FA_CODE` | 2FA code, required with email/password login if your account has two-factor authentication enabled. |

### Getting an API key

Per the [official Filen API docs](https://docs.filen.io/docs/api/guides/authentication/), the API key is returned by the `POST /v3/login` response (email + derived password + 2FA code), and each API call is then authenticated with `Authorization: Bearer <api_key>`. In practice the easiest way to obtain it is the **Filen CLI**: log in once (including 2FA) and run `filen export-api-key` (see [docs.cli.filen.io](https://docs.cli.filen.io/) and the [rclone docs](https://rclone.org/filen/), which state this is currently only possible via the CLI). The SDK does the login under the hood when you call `filen.init({ apiKey })`.

Notes:

- The API key itself needs **no 2FA** — fetch it once and set it as `FILEN_API_KEY` in your MCP client config; the server authorizes automatically on every start.
- The API key becomes invalid if you change your Filen account password — then export a new one.
- Treat the API key like a password: only in the MCP client config or a git-ignored `.env`, never in the repo.

If neither `FILEN_API_KEY` nor `FILEN_EMAIL` + `FILEN_PASSWORD` is set, the server prints a clear error and exits with code 1.

You can also put them in a local `.env` file (git-ignored) and load it with your favorite dotenv runner, e.g. `npx dotenvx run -- npm start`.

## Client configuration

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "filen": {
      "command": "node",
      "args": ["/absolute/path/to/FileN-MCP/dist/index.js"],
      "env": {
        "FILEN_API_KEY": "your-api-key"
      }
    }
  }
}
```

(Use `FILEN_EMAIL`, `FILEN_PASSWORD` and optionally `FILEN_2FA_CODE` instead of `FILEN_API_KEY` if you prefer.)

### Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "filen": {
      "command": "node",
      "args": ["/absolute/path/to/FileN-MCP/dist/index.js"],
      "env": {
        "FILEN_API_KEY": "your-api-key"
      }
    }
  }
}
```

Replace `/absolute/path/to/FileN-MCP` with the real clone path on your machine.

## Security notes

- **stdio only:** the server listens exclusively on stdio on the local machine; it opens no network port. It only talks to Filen's API endpoints.
- **Zero-knowledge stays intact:** all encryption/decryption happens locally inside `@filen/sdk` using your own keys. The server never sees plaintext keys beyond what the SDK needs, and Filen's servers never see your file contents.
- **Credentials via env only:** no credentials are hardcoded or committed; `.env` is git-ignored.
- **`read_file` has a 5 MB cap** so a single tool call cannot pull huge files into the model context; use `download_file` for larger files.
- **`delete_item` defaults to the trash** (`permanent=false`); permanent deletion requires explicitly setting `permanent=true`.
- **Unofficial & use at your own risk:** this is a community server, not affiliated with Filen. API/SDK behavior may change without notice.

## Development

```sh
npm run dev      # build + run
npm run build    # compile TypeScript to dist/
npm start        # run dist/index.js
npm run inspect  # MCP Inspector
```

## License

[AGPL-3.0](LICENSE) — matching the license of the Filen SDK (`@filen/sdk`).
