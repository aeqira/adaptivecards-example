import { Hono } from "hono";

type Bindings = Env & {
	adaptive_cards: R2Bucket;
};

const App = new Hono<{ Bindings: Bindings }>();

App.get("/api/:cardName", async (c) => {
	const cardName = c.req.param("cardName");
	const bucket = c.env.adaptive_cards;

	if (!bucket) {
		return c.json({ error: "R2 binding \"adaptive_cards\" is not configured" }, 500);
	}

	const objectKeys = [
		`${cardName}.json`,
		cardName,
		`adaptive-card-variables/${cardName}.json`,
		`adaptive-card-variables/${cardName}`,
	];
	let cardObject: R2ObjectBody | null = null;
	let objectKey = "";

	for (const key of objectKeys) {
		cardObject = await bucket.get(key);
		if (cardObject) {
			objectKey = key;
			break;
		}
	}

	if (!cardObject) {
		return c.json(
			{
				error: `Card "${cardName}" was not found`,
				checkedKeys: objectKeys,
			},
			404,
		);
	}

	try {
		const card = JSON.parse(await cardObject.text());

		return c.json({ card, objectKey });
	} catch {
		return c.json({ error: `Card "${objectKey}" is not valid JSON` }, 422);
	}
});

export default App;
