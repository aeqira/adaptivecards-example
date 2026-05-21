import { Hono, type Context } from "hono";

type Bindings = Env & {
	adaptive_cards: D1Database;
};

type TableRow = Record<string, unknown>;
type SchemaColumn = {
	name: string;
};

const App = new Hono<{ Bindings: Bindings }>();
type AppContext = Context<{ Bindings: Bindings }>;

const identityColumns = [
	"id",
	"key",
	"name",
	"slug",
	"title",
	"filename",
	"card_name",
	"cardName",
	"card_id",
	"cardId",
];

const cardColumns = [
	"card",
	"adaptive_card",
	"adaptiveCard",
	"template",
	"payload",
	"content",
	"json",
	"value",
	"data",
	"body",
];

function quoteIdentifier(identifier: string) {
	return `"${identifier.replaceAll(`"`, `""`)}"`;
}

function parseMaybeJson(value: unknown) {
	if (typeof value !== "string") {
		return value;
	}

	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

function isObject(value: unknown): value is TableRow {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function looksLikeCardPayload(value: unknown) {
	return isObject(value) && ("type" in value || "body" in value || "actions" in value);
}

function extractCard(row: TableRow) {
	for (const column of cardColumns) {
		if (!(column in row)) {
			continue;
		}

		const value = parseMaybeJson(row[column]);
		if (looksLikeCardPayload(value)) {
			return value;
		}
	}

	for (const value of Object.values(row)) {
		const parsedValue = parseMaybeJson(value);
		if (looksLikeCardPayload(parsedValue)) {
			return parsedValue;
		}
	}

	return row;
}

async function getColumns(db: D1Database, tableName: string) {
	try {
		const result = await db
			.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`)
			.all<SchemaColumn>();

		return result.results ?? [];
	} catch {
		return [];
	}
}

async function findCardRow(db: D1Database, tableName: string, columns: string[], cardName: string) {
	const searchableColumns = columns.filter((column) => identityColumns.includes(column));

	if (searchableColumns.length === 0) {
		return null;
	}

	const whereClause = searchableColumns
		.map((column) => `${quoteIdentifier(column)} IN (?, ?)`)
		.join(" OR ");
	const params = searchableColumns.flatMap(() => [cardName, `${cardName}.json`]);

	return db
		.prepare(`SELECT * FROM ${quoteIdentifier(tableName)} WHERE ${whereClause} LIMIT 1`)
		.bind(...params)
		.first<TableRow>();
}

function getCardNameFromRequest(c: AppContext) {
	return (
		c.req.param("cardName") ||
		c.req.query("card") ||
		c.req.query("q") ||
		c.req.query("name") ||
		""
	).trim();
}

async function getCard(c: AppContext) {
	const cardName = getCardNameFromRequest(c);
	const db = c.env.adaptive_cards;

	if (!cardName) {
		return c.json({ error: "Missing card search term" }, 400);
	}

	if (!db) {
		return c.json({ error: "D1 binding \"adaptive_cards\" is not configured" }, 500);
	}

	const checkedTables: Array<{ table: string; columns: string[] }> = [];

	try {
		const tableName = "cards";
		const columns = (await getColumns(db, tableName)).map((column) => column.name);
		checkedTables.push({ table: tableName, columns });

		const row = await findCardRow(db, tableName, columns, cardName);
		if (row) {
			return c.json({
				card: extractCard(row),
				source: {
					table: tableName,
					columns,
				},
			});
		}

		return c.json(
			{
				error: `Card "${cardName}" was not found in D1`,
				checkedTables,
			},
			404,
		);
	} catch (error) {
		return c.json(
			{
				error: error instanceof Error ? error.message : "Failed to query D1",
				checkedTables,
			},
			500,
		);
	}
}

App.get("/api", getCard);
App.get("/api/:cardName", getCard);

export default App;
