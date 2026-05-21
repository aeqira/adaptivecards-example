import { Hono, type Context } from "hono";

type Bindings = Env & {
	adaptive_cards: D1Database;
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
			const card = parseMaybeJson(row.payload);

			if (!looksLikeCardPayload(card)) {
				return c.json(
					{
						error: "Stored card payload is not a valid Adaptive Card JSON payload",
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
