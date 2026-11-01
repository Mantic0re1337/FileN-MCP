#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FilenSDK } from "@filen/sdk";
import { z } from "zod";

const SERVER_NAME = "filen-mcp";
const SERVER_VERSION = "0.1.0";

/** read_file refuses to load files larger than 5 MB into memory. */
const MAX_READ_FILE_SIZE = 5 * 1024 * 1024;

type ToolResult = {
	content: { type: "text"; text: string }[];
	isError?: boolean;
};

function ok(data: unknown): ToolResult {
	return {
		content: [
			{
				type: "text",
				text: typeof data === "string" ? data : JSON.stringify(data, null, 2)
			}
		]
	};
}

function err(error: unknown): ToolResult {
	const message = error instanceof Error ? error.message : String(error);
	return {
		content: [{ type: "text", text: `Error: ${message}` }],
		isError: true
	};
}

/** Normalize a user supplied path to an absolute cloud path starting at "/". */
function toCloudPath(input: string): string {
	if (typeof input !== "string" || input.trim().length === 0) {
		throw new Error("path must be a non-empty absolute path starting with '/'");
	}
	const withLeadingSlash = input.startsWith("/") ? input : `/${input}`;
	const normalized = path.posix.normalize(withLeadingSlash);
	return normalized === "." ? "/" : normalized;
}

async function resolveCredentials(filen: FilenSDK): Promise<void> {
	const apiKey = process.env.FILEN_API_KEY?.trim();
	const email = process.env.FILEN_EMAIL?.trim();
	const password = process.env.FILEN_PASSWORD;
	const twoFactorCode = process.env.FILEN_2FA_CODE?.trim();

	if (!apiKey && !(email && password)) {
		throw new Error(
			"missing Filen credentials: set FILEN_API_KEY, or FILEN_EMAIL and FILEN_PASSWORD (plus FILEN_2FA_CODE if 2FA is enabled)"
		);
	}

	if (apiKey) {
		filen.init({ apiKey });
	} else {
		await filen.login({
			email: email as string,
			password: password as string,
			twoFactorCode
		});
	}
}

async function main(): Promise<void> {
	const filen = new FilenSDK({
		metadataCache: true,
		connectToSocket: false,
		tmpPath: path.join(os.tmpdir(), "filen-mcp")
	});

	try {
		await resolveCredentials(filen);
	} catch (error) {
		console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}

	const fs = filen.fs();

	const server = new McpServer(
		{ name: SERVER_NAME, version: SERVER_VERSION },
		{ capabilities: { tools: {} } }
	);

	server.registerTool(
		"list_directory",
		{
			title: "List directory",
			description:
				"List the entries of a Filen cloud directory. Paths are absolute, starting at '/'.",
			inputSchema: {
				path: z.string().describe("Absolute cloud path of the directory, e.g. '/' or '/Documents'"),
				recursive: z
					.boolean()
					.optional()
					.describe("If true, list all entries recursively below path")
			},
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				openWorldHint: false
			}
		},
		async ({ path: dirPath, recursive }) => {
			try {
				const entries = await fs.readdir({ path: toCloudPath(dirPath), recursive });
				return ok(entries);
			} catch (error) {
				return err(error);
			}
		}
	);

	server.registerTool(
		"stat",
		{
			title: "Stat item",
			description: "Get metadata (type, uuid, size, timestamps) of a file or directory in the Filen cloud.",
			inputSchema: {
				path: z.string().describe("Absolute cloud path of the item, e.g. '/Documents/report.pdf'")
			},
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				openWorldHint: false
			}
		},
		async ({ path: itemPath }) => {
			try {
				const stats = await fs.stat({ path: toCloudPath(itemPath) });
				return ok({
					type: stats.type,
					uuid: stats.uuid,
					size: stats.size,
					mtimeMs: stats.mtimeMs,
					birthtimeMs: stats.birthtimeMs
				});
			} catch (error) {
				return err(error);
			}
		}
	);

	server.registerTool(
		"read_file",
		{
			title: "Read file",
			description:
				"Read a text file from the Filen cloud and return its UTF-8 content. Refuses files that are not regular files or larger than 5 MB (use download_file for those).",
			inputSchema: {
				path: z.string().describe("Absolute cloud path of the file to read")
			},
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				openWorldHint: false
			}
		},
		async ({ path: filePath }) => {
			try {
				const cloudPath = toCloudPath(filePath);
				const stats = await fs.stat({ path: cloudPath });
				if (!stats.isFile()) {
					return err(`path is not a file (type: ${stats.type})`);
				}
				if (stats.size > MAX_READ_FILE_SIZE) {
					return err(
						`file is ${stats.size} bytes, exceeding the ${MAX_READ_FILE_SIZE} byte (5 MB) limit for read_file; use download_file to fetch it to a local path instead`
					);
				}
				const content = await fs.readFile({ path: cloudPath });
				return ok(content.toString("utf-8"));
			} catch (error) {
				return err(error);
			}
		}
	);

	server.registerTool(
		"search_files",
		{
			title: "Search files",
			description:
				"Search the Filen cloud for files/directories whose path contains the query (case-insensitive substring match).",
			inputSchema: {
				query: z.string().min(1).describe("Search query, matched case-insensitively against full cloud paths"),
				path: z
					.string()
					.optional()
					.default("/")
					.describe("Absolute cloud path of the directory to search in (recursive). Defaults to '/'")
			},
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				openWorldHint: false
			}
		},
		async ({ query, path: searchPath }) => {
			try {
				const root = toCloudPath(searchPath);
				const entries = await fs.readdir({ path: root, recursive: true });
				const needle = query.toLowerCase();
				const matches = entries.filter((entry) => entry.toLowerCase().includes(needle));
				return ok(matches);
			} catch (error) {
				return err(error);
			}
		}
	);

	server.registerTool(
		"write_file",
		{
			title: "Write file",
			description:
				"Write UTF-8 text content to a file in the Filen cloud, creating or overwriting it. Parent directories are created automatically.",
			inputSchema: {
				path: z.string().describe("Absolute cloud path of the file to write, e.g. '/notes/todo.txt'"),
				content: z.string().describe("Text content to write (UTF-8)")
			},
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				openWorldHint: false
			}
		},
		async ({ path: filePath, content }) => {
			try {
				const cloudPath = toCloudPath(filePath);
				const item = await fs.writeFile({
					path: cloudPath,
					content: Buffer.from(content, "utf-8")
				});
				return ok({ path: cloudPath, uuid: item.uuid, type: item.type });
			} catch (error) {
				return err(error);
			}
		}
	);

	server.registerTool(
		"upload_file",
		{
			title: "Upload file",
			description:
				"Upload a local file (or directory) from the machine running this server into the Filen cloud. Parent directories are created automatically.",
			inputSchema: {
				source: z.string().describe("Absolute local path of the file/directory to upload, e.g. 'C:\\Users\\me\\file.pdf' or '/home/me/file.pdf'"),
				path: z.string().describe("Absolute cloud destination path, e.g. '/Documents/file.pdf'")
			},
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				openWorldHint: false
			}
		},
		async ({ source, path: cloudPath }) => {
			try {
				const item = await fs.upload({ source, path: toCloudPath(cloudPath) });
				return ok({ path: toCloudPath(cloudPath), uuid: item.uuid, type: item.type });
			} catch (error) {
				return err(error);
			}
		}
	);

	server.registerTool(
		"download_file",
		{
			title: "Download file",
			description:
				"Download a file (or directory) from the Filen cloud to a local destination path on the machine running this server.",
			inputSchema: {
				path: z.string().describe("Absolute cloud path of the file/directory to download"),
				destination: z.string().describe("Absolute local destination path, e.g. 'C:\\Users\\me\\Downloads\\file.pdf'")
			},
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				openWorldHint: false
			}
		},
		async ({ path: cloudPath, destination }) => {
			try {
				await fs.download({ path: toCloudPath(cloudPath), destination });
				return ok({ path: toCloudPath(cloudPath), destination });
			} catch (error) {
				return err(error);
			}
		}
	);

	server.registerTool(
		"create_folder",
		{
			title: "Create folder",
			description:
				"Create a folder in the Filen cloud. Intermediate directories are created recursively if missing.",
			inputSchema: {
				path: z.string().describe("Absolute cloud path of the folder to create, e.g. '/Projects/2026'")
			},
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				openWorldHint: false
			}
		},
		async ({ path: folderPath }) => {
			try {
				const cloudPath = toCloudPath(folderPath);
				const uuid = await fs.mkdir({ path: cloudPath });
				return ok({ path: cloudPath, uuid });
			} catch (error) {
				return err(error);
			}
		}
	);

	server.registerTool(
		"delete_item",
		{
			title: "Delete item",
			description:
				"Delete a file or directory from the Filen cloud. By default the item is moved to the trash; set permanent=true to delete it permanently.",
			inputSchema: {
				path: z.string().describe("Absolute cloud path of the item to delete"),
				permanent: z
					.boolean()
					.optional()
					.default(false)
					.describe("If true, delete permanently instead of moving to trash")
			},
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				openWorldHint: false
			}
		},
		async ({ path: itemPath, permanent }) => {
			try {
				const cloudPath = toCloudPath(itemPath);
				await fs.unlink({ path: cloudPath, permanent });
				return ok({ path: cloudPath, permanent });
			} catch (error) {
				return err(error);
			}
		}
	);

	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error(`${SERVER_NAME} v${SERVER_VERSION} running on stdio`);
}

main().catch((error) => {
	console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
