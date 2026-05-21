import { Hono, type Context } from "hono";

type Bindings = Env & {
	adaptive_cards: D1Database;
	adaptive_card_variables: R2Bucket;
};

type CardRow = {
	payload: string;
};

const App = new Hono<{ Bindings: Bindings }>();
type AppContext = Context<{ Bindings: Bindings }>;

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

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function looksLikeCardPayload(value: unknown) {
	return isObject(value) && ("type" in value || "body" in value || "actions" in value);
}

function getPathValue(source: Record<string, unknown>, path: string) {
	return path.split(".").reduce<unknown>((current, segment) => {
		if (!isObject(current)) {
			return undefined;
		}

		return current[segment];
	}, source);
}

function bindString(value: string, data: Record<string, unknown>) {
	const exactMatch = value.match(/^\$\{([A-Za-z0-9_.-]+)\}$/);
	if (exactMatch) {
		const replacement = getPathValue(data, exactMatch[1]);

		return replacement === undefined || replacement === null ? "" : replacement;
	}

	return value.replace(/\$\{([A-Za-z0-9_.-]+)\}/g, (_match, path: string) => {
		const replacement = getPathValue(data, path);

		return replacement === undefined || replacement === null ? "" : String(replacement);
	});
}

function bindData(value: unknown, data: Record<string, unknown>): unknown {
	if (typeof value === "string") {
		return bindString(value, data);
	}

	if (Array.isArray(value)) {
		return value.map((item) => bindData(item, data));
	}

	if (isObject(value)) {
		return Object.fromEntries(
			Object.entries(value).map(([key, childValue]) => [key, bindData(childValue, data)]),
		);
	}

	return value;
}

async function getBindingData(bucket: R2Bucket | undefined, cardName: string) {
	if (!bucket) {
		return {};
	}

	const keys = [`${cardName}.json`, cardName];

	for (const key of keys) {
		const object = await bucket.get(key);
		if (!object) {
			continue;
		}

		const data = parseMaybeJson(await object.text());
		if (!isObject(data)) {
			return {};
		}

		return data;
	}

	return {};
}

function expandCardTemplate(templatePayload: unknown, data: Record<string, unknown>) {
	return bindData(templatePayload, data);
}

async function findCardRow(db: D1Database, cardName: string) {
	return db
		.prepare(
			`
				SELECT payload
				FROM cards
				WHERE name = ?
				LIMIT 1
			`,
		)
		.bind(cardName)
		.first<CardRow>();
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
	const variablesBucket = c.env.adaptive_card_variables;

	if (!cardName) {
		return c.json({ error: "Missing card search term" }, 400);
	}

	if (cardName.length > 128) {
		return c.json({ error: "Card search term is too long" }, 400);
	}

	if (!db) {
		return c.json({ error: "Card database is not configured" }, 500);
	}

	try {
		const row = await findCardRow(db, cardName);
		if (row) {
			const templatePayload = parseMaybeJson(row.payload);

			if (!looksLikeCardPayload(templatePayload)) {
				return c.json(
					{
						error: "Stored card payload is not a valid Adaptive Card JSON payload",
					},
					422,
				);
			}

			const data = await getBindingData(variablesBucket, cardName);
			const card = expandCardTemplate(templatePayload, data);

			if (!looksLikeCardPayload(card)) {
				return c.json(
					{
						error: "Expanded card payload is not a valid Adaptive Card JSON payload",
					},
					422,
				);
			}

			return c.json({ card });
		}

		return c.json(
			{
				error: "Card was not found",
			},
			404,
		);
	} catch {
		return c.json(
			{
				error: "Failed to load card",
			},
			500,
		);
	}
}

App.get("/api", getCard);
App.get("/api/:cardName", getCard);

export default App;
