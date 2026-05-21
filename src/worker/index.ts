import { Hono, type Context } from "hono";

type Bindings = Env & {
	adaptive_cards: D1Database;
	adaptive_card_variables: R2Bucket;
};

type CardRow = {
	data: string | null;
	payload: string;
};

type BindingSpec =
	| {
			key: string;
			name: string;
			type: "r2";
	  }
	| {
			name: string;
			query: string;
			type: "d1";
	  };

const App = new Hono<{ Bindings: Bindings }>();
type AppContext = Context<{ Bindings: Bindings }>;
const bindingPattern = /\$\{([A-Za-z0-9_.-]+)\}/g;
const maxBindingsPerCard = 50;
const maxBindingBytes = 256 * 1024;
const maxQueryRows = 100;

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

	return value.replace(bindingPattern, (_match, path: string) => {
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

function isSafeBindingName(value: string) {
	return /^[A-Za-z0-9_.-]{1,128}$/.test(value);
}

function getR2BindingName(key: string) {
	return key.endsWith(".json") ? key.slice(0, -".json".length) : key;
}

async function getR2BindingValue(bucket: R2Bucket, bindingName: string) {
	const object = await bucket.get(bindingName);
	if (!object || object.size > maxBindingBytes) {
		return undefined;
	}

	const text = await object.text();

	return parseMaybeJson(text);
}

function isSafeReadQuery(query: string) {
	const normalizedQuery = query.trim().toLowerCase();

	return (
		(normalizedQuery.startsWith("select ") || normalizedQuery.startsWith("with ")) &&
		!normalizedQuery.includes(";") &&
		!normalizedQuery.includes("--") &&
		!normalizedQuery.includes("/*") &&
		!/\b(insert|update|delete|drop|alter|create|replace|pragma|attach|detach|vacuum)\b/.test(
			normalizedQuery,
		)
	);
}

function shapeQueryResult(rows: Record<string, unknown>[]) {
	if (rows.length !== 1) {
		return rows;
	}

	const row = rows[0];
	const values = Object.values(row);

	return values.length === 1 ? parseMaybeJson(values[0]) : row;
}

async function getD1BindingValue(db: D1Database, query: string) {
	if (!isSafeReadQuery(query)) {
		return undefined;
	}

	try {
		const result = await db.prepare(query).all<Record<string, unknown>>();
		const rows = result.results ?? [];

		return shapeQueryResult(rows.slice(0, maxQueryRows));
	} catch {
		return undefined;
	}
}

function getBindingSpecs(dataColumn: unknown): BindingSpec[] {
	const parsedData = parseMaybeJson(dataColumn);

	if (typeof parsedData === "string") {
		return isSafeBindingName(parsedData)
			? [{ key: parsedData, name: getR2BindingName(parsedData), type: "r2" }]
			: [];
	}

	if (Array.isArray(parsedData)) {
		const specs: BindingSpec[] = [];

		for (const value of parsedData) {
			if (typeof value === "string" && isSafeBindingName(value)) {
				specs.push({ key: value, name: getR2BindingName(value), type: "r2" });
				continue;
			}

			if (!isObject(value)) {
				continue;
			}

			for (const [name, query] of Object.entries(value)) {
				if (typeof query === "string" && isSafeBindingName(name)) {
					specs.push({ name, query, type: "d1" });
				}
			}
		}

		return specs.slice(0, maxBindingsPerCard);
	}

	if (isObject(parsedData)) {
		const bindings = parsedData.bindings ?? parsedData.bindingNames ?? parsedData.data;
		if (Array.isArray(bindings)) {
			return getBindingSpecs(bindings);
		}

		return Object.entries(parsedData)
			.flatMap(([name, value]): BindingSpec[] => {
				if (!isSafeBindingName(name)) {
					return [];
				}

				if (typeof value === "string" && isSafeReadQuery(value)) {
					return [{ name, query: value, type: "d1" }];
				}

				return [{ key: name, name: getR2BindingName(name), type: "r2" }];
			})
			.slice(0, maxBindingsPerCard);
	}

	return [];
}

async function getBindingData(
	db: D1Database,
	bucket: R2Bucket | undefined,
	bindingSpecs: BindingSpec[],
) {
	const data: Record<string, unknown> = {};

	for (const spec of bindingSpecs.slice(0, maxBindingsPerCard)) {
		if (spec.type === "r2") {
			if (!bucket) {
				continue;
			}

			const value = await getR2BindingValue(bucket, spec.key);
			if (value === undefined) {
				continue;
			}

			data[spec.name] = value;
		} else {
			const value = await getD1BindingValue(db, spec.query);
			if (value === undefined) {
				continue;
			}

			data[spec.name] = value;
		}
	}

	return data;
}

function expandCardTemplate(templatePayload: unknown, data: Record<string, unknown>) {
	return bindData(templatePayload, data);
}

async function findCardRow(db: D1Database, cardName: string) {
	return db
		.prepare(
			`
				SELECT payload, data
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

			const bindingSpecs = getBindingSpecs(row.data);
			const data = await getBindingData(db, variablesBucket, bindingSpecs);
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
